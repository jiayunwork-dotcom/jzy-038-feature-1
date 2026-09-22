# symcomp-service — 三相对称分量换算与单相接地故障核算服务

以「换算批次」为中心组织的 HTTP 服务：

- **正变换**：三相相量（每相有效值 RMS + 相角度数）→ 零序 / 正序 / 负序；
- **反变换**：三个序分量 → 三相相量；
- **单相接地（SLG，A 相）故障核算**：给三序阻抗与故障前正序电压，算序电流、故障相电流与电压跌落；
- 电压、电流共用**同一套系数、同一个旋转算子**，不维护两份只差共轭的实现；
- 正反变换严格配对：任意三相先正再反（或先反再正），结果在 `1e-9` 容差内回到原值（自动化测试守着）。

技术栈：Node.js 20 + TypeScript + Fastify；复数运算自封装；持久化支持 PostgreSQL（容器默认）与进程内内存（默认/测试）。

---

## 1. 钉死的对称分量定义

旋转因子（全服务唯一，`src/complex.ts`）：

```
a = e^(j·120°) = -1/2 + j·√3/2 ,   a² = e^(-j·120°)
```

**正变换（含 1/3 系数）**：

```
V0 = (Va + Vb    + Vc ) / 3          零序
V1 = (Va + a·Vb  + a²·Vc) / 3        正序
V2 = (Va + a²·Vb + a·Vc ) / 3        负序
```

**反变换**：

```
Va = V0 + V1  + V2
Vb = V0 + a²·V1 + a·V2
Vc = V0 + a·V1  + a²·V2
```

实现上，正变换矩阵不是手抄的，而是由反变换（合成）矩阵 `S` **直接求逆** `S⁻¹` 得到（`src/kernel/transform.ts`），因此两侧系数在数值上严格互逆，闭合误差只来自浮点舍入。测试 `A·S = I` 验证这一点。

约定：正序相序为 A∠0°、B∠-120°、C∠+120°；把 B、C 对调即转为负序。电压电流用同一套定义，没有共轭分支。

### 批次级相序标定（calibration）

不同变电站/厂商对"哪个是正序"标定不一、老旧计量装置零度参考点存在固定偏移。标定以**批次**为单位开立时选定、开立后冻结，不指定则沿用服务默认标定：

```json
{ "direction": "forward", "referenceOffsetDeg": 0 }
```

- **`direction`（相序方向）**：
  - `forward`：上面钉死的默认约定（缺省值）；
  - `reverse`：现场反向标定，调用方表述中的正序/负序与默认约定对调（等价 B、C 互换角色）。同一组三相在 `forward/0` 与 `reverse/0` 两批次下正变换，正序、负序结果**正好互换**，零序不受影响。
- **`referenceOffsetDeg`（基准相角偏移 δ，度，任意有限角度）**：这批数据的零度参考点相对服务默认零度转过的角度。所有输入相量先进服务参考系（相角减 δ）再进数学核心，核心输出再加回 δ 换回调用方参考系 —— 调用方无需在服务外手动搬角度。阻抗是不随参考零点旋转的比值量、`rf` 与跌落为标量，不参与旋转。

标定只有**唯一下水点**（`src/calibration.ts` 的 `CalibratedEngine`）：正变换、反变换、故障核算都走同一个引擎实例，不允许各自实现一份。数学上严格可逆 —— 任意三相先按某标定正变换、再按同一标定反变换，在 `1e-9` 容差内精确还原，方向对调（自逆置换）与角度旋转（互为逆角）任意组合都成立。故障核算与变换共用同一标定：把故障输出的序电压用同一批次反变换回三相，重建出的 A 相电压恰等于 `faultedPhaseVoltage`。

**冻结与留痕**：批次一旦开立，标定不可变更（`PATCH` 携带 `calibration` 一律 `409 BATCH_CALIBRATION_FROZEN`，仅备注可改）；批次与批次内每条记录都留存当时的标定快照，回看任意记录即可辨认口径，之后服务默认标定如何变化都不影响已开立批次。

**旧数据兼容**：能力上线前建立的批次没有标定信息，统一认定为服务当初唯一支持的默认标定（`forward/0`，PG 迁移由列 `DEFAULT` 兜底，读取侧 `resolveStoredCalibration` 宽容认定）。δ=0 时标定层是恒等快路径（直接返回原复数，非近似），旧批次追加记录或重新核算旧输入的结果与升级前**逐位一致**，升级不是破坏性变更。

### 单相接地故障（故障落在 A 相）

三序网络串联，序电流相等：

```
I1 = I2 = I0 = Vf / (Z1 + Z2 + Z0 + 3·Rf)
故障相电流  Ia = 3·I0
故障相电压  Va = 3·Rf·I1
序网电压    V1 = Vf - I1·Z1 ,  V2 = -I2·Z2 ,  V0 = -I0·Z0
电压跌落    sag = |Vf| - |Va|
```

`Rf` 可省略（缺省 0，金属性接地）。三个序阻抗的**实部（电阻分量）必须严格为正**，否则以 `IMPEDANCE_NON_POSITIVE` 拒绝；`Rf` 为负以 `FAULT_IMPEDANCE_NON_POSITIVE` 拒绝。

---

## 2. HTTP API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/batches` | 开立批次（可带 `calibration`，缺省默认标定；非法标定 400 且不建批次） |
| PATCH | `/batches/:id` | 修改批次（仅 `note` 可改；带 `calibration` 返回 409 冻结拒绝） |
| POST | `/batches/:id/records` | 投入一条（对象）或多条（数组）记录 |
| GET  | `/batches/:id` | 查批次（含冻结标定与全部记录） |
| GET  | `/batches/:id/records` | 取批次内全部记录（响应含批次标定） |
| GET  | `/batches/:id/records/:rid` | 只取一条记录（含该条使用的标定快照） |
| GET  | `/health` | 健康检查 |

每条记录都留存：原始输入、输出结果、变换方向、状态（`ok`/`rejected`）、结构化错误，以及**当批标定快照**。**校验不过的记录也入库**（单条投递返回 422，批量投递返回 200、逐条标状态），不会被悄悄丢弃。

### 开立带标定的批次

```bash
curl -s -X POST localhost:8080/batches -H 'content-type: application/json' -d '{
  "note": "reverse-wiring substation, -12.5° reference",
  "calibration": { "direction": "reverse", "referenceOffsetDeg": -12.5 }
}'
# -> {"id":"<BATCH_ID>","note":"...","calibration":{"direction":"reverse","referenceOffsetDeg":-12.5}, ...}
```

`calibration` 整体或其中任一字段均可省略（取默认 `forward` / `0`）。非法标定（方向非 `forward`/`reverse`、偏移为 NaN/Infinity/非数值、结构非对象、未知字段）在开立阶段即被结构化拒绝，**不产生批次**。

### 正变换（三相 → 序）

```bash
curl -s -X POST localhost:8080/batches -H 'content-type: application/json' -d '{"note":"demo"}'
# -> {"id":"<BATCH_ID>", ...}

curl -s -X POST localhost:8080/batches/<BATCH_ID>/records \
  -H 'content-type: application/json' \
  -d '{
    "kind": "transform",
    "quantity": "voltage",
    "direction": "phase->sequence",
    "phaseMode": "phase",
    "phases": {
      "a": {"magnitude": 12.5, "angleDeg": 20},
      "b": {"magnitude": 8.1,  "angleDeg": -95},
      "c": {"magnitude": 15.3, "angleDeg": 140}
    }
  }'
```

`quantity`：`voltage` 或 `current`（同一套算子）。`phaseMode`：`phase`（相量，缺省）或 `line`（线量，不含零序）。

### 反变换（序 → 三相）

```bash
curl -s -X POST localhost:8080/batches/<BATCH_ID>/records \
  -H 'content-type: application/json' \
  -d '{
    "kind": "transform",
    "quantity": "current",
    "direction": "sequence->phase",
    "sequence": {
      "zero":     {"magnitude": 0, "angleDeg": 0},
      "positive": {"magnitude": 100, "angleDeg": 0},
      "negative": {"magnitude": 0, "angleDeg": 0}
    }
  }'
```

> 序分量幅值允许为 0（纯正/纯零序的正常情况）；但三相相量输入幅值必须严格为正。
> `phaseMode:"line"` 反变换时 `sequence.zero` 必须为 0（线电压不含零序），否则 `LINE_ZERO_SEQUENCE_NOT_ZERO`。电流不支持 `line` 模式。

### 故障核算（批次中的特殊记录）

```bash
curl -s -X POST localhost:8080/batches/<BATCH_ID>/records \
  -H 'content-type: application/json' \
  -d '{
    "kind": "fault",
    "z1": {"magnitude": 1.0, "angleDeg": 80},
    "z2": {"magnitude": 1.0, "angleDeg": 80},
    "z0": {"magnitude": 2.0, "angleDeg": 75},
    "vf": {"magnitude": 1.0, "angleDeg": 0},
    "rf": 0.1
  }'
```

返回 `iSequence`（序电流 I1=I2=I0）、`faultCurrent`（=3I0）、`sequenceVoltages`（V0/V1/V2）、`faultedPhaseVoltage`、`voltageSag`。

### 错误结构（4xx，服务不崩）

```json
{
  "status": "rejected",
  "result": null,
  "errors": [
    {"code": "MAGNITUDE_NON_POSITIVE", "field": "phases.b.magnitude", "message": "phases.b.magnitude 必须为正，收到 -5"}
  ]
}
```

错误类型：`MAGNITUDE_NON_POSITIVE` / `MISSING_PHASE` / `ANGLE_NOT_FINITE` / `MALFORMED_PHASOR` / `IMPEDANCE_NON_POSITIVE` / `FAULT_IMPEDANCE_NON_POSITIVE` / `LINE_ZERO_SEQUENCE_NOT_ZERO` / `LINE_MODE_NOT_APPLICABLE_TO_CURRENT` / `CALIBRATION_INVALID` / `CALIBRATION_OFFSET_NOT_FINITE` / `CALIBRATION_DIRECTION_INVALID` / `CALIBRATION_MALFORMED` / `BATCH_CALIBRATION_FROZEN` / `BATCH_NOT_FOUND` / `RECORD_NOT_FOUND` / `VALIDATION_FAILED` / `UNSUPPORTED_RECORD`。

---

## 3. 本地开发与测试

```bash
npm ci
npm test          # vitest，103 个用例（内核 + 标定 + 校验 + HTTP + 并发 + 仓储）
npm run build     # tsc -> dist/
npm start         # 默认内存存储，:8080
STORAGE=postgres DATABASE_URL=postgres://symcomp:symcomp@localhost:5432/symcomp npm start
```

测试覆盖的物理关系：

- **正反闭合**：随机三相 / 随机序量双向闭合（含 forward+reverse × 9 组偏移角度的全组合）；`A·S=I` 矩阵互逆；
- **标定方向**：同一输入 forward/0 与 reverse/0 正变换正负序严格互换、零序不变；平衡情形能量整体换标签；
- **标定偏移**：任意偏移下正反变换精确还原；两侧闭环（输入减 δ、输出加 δ），跨帧换算严格互逆；δ=0 恒等快路径与旧内核逐位一致；
- **故障同标定**：带标定批次的故障序电压用同一引擎反变换重建出故障相电压；金属性接地边界条件在任意标定下成立；
- **冻结与旧数据**：非法偏移/方向开立 400 不建批次；改标定 409；无标定字段的旧批次按默认认定且追加/重算结果逐位一致；
- **平衡退化**：平衡正序输入 V2=V0=0、|V1|=相电压幅值；纯正序反变换三相等幅、互差 120°；
- **三倍零序**：Va+Vb+Vc = 3V0；
- **相序反转能量转移**：B/C 对调后 |V1| 与 |V2| 互换；平衡情形能量全部转移；序能量守恒；
- **电压电流同一算子**：内核不区分 quantity，平衡电流同样退化；
- **线电压**：Vab/Vbc/Vca 零序为零、正序超前 30°、幅值 √3 倍；
- **故障趋势**：序电流随 Rf 增大而减小、跌落同向减小；Z0 增大时序电流减小、跌落增大；Vf 升高时二者同向增大；
- **非法输入**：幅值非正、缺相、角度 NaN/Infinity、阻抗实部非正、Rf 为负、线量带零序等全部结构化拒绝；
- **并发隔离**：4 个批次并发各投 12 条，索引连续、不串号、不覆盖。

## 4. 容器部署（服务 + 存储一份配置拉起）

```bash
docker compose up --build
```

该配置启动：

- `db`：PostgreSQL 16（持久化卷 `pgdata`，带健康检查）；
- `api`：本服务，等数据库健康后启动，自动执行建表迁移，映射到宿主机 `8080`。

环境变量：`STORAGE`（`postgres`/`memory`）、`DATABASE_URL`、`PORT`、`HOST`。

## 5. 模块结构（按职责拆分）

```
src/
  complex.ts              复数运算 + 旋转算子 a（唯一一份）
  calibration.ts          批次标定模型、开立严格解析、旧数据宽容认定、CalibratedEngine（唯一下水点）
  types.ts                对外/对内数据模型与错误类型
  validation.ts           带类型的输入校验（线量零序检查也走标定引擎）
  records.ts              记录处理引擎（校验 -> 标定归正 -> 内核 -> 标定换回 -> 留存）
  app.ts                  Fastify 装配与统一错误处理
  server.ts               入口与存储选择
  config.ts               环境配置
  kernel/
    transform.ts          正反变换内核（合成矩阵 + 其逆，只认服务默认约定）
    fault.ts              单相接地序网核算内核
  routes/
    records.ts            HTTP 路由（批次开立/冻结/记录）
  persistence/
    repository.ts         仓储接口（标定冻结：无改标定入口，仅 updateBatchNote）
    memory.ts             内存实现（测试/默认，含旧格式批次植入辅助）
    postgres.ts           PostgreSQL 实现（标定两列 + 记录快照 JSONB）
  db/migrate.ts           建表迁移（幂等；标定列 DEFAULT 兜底旧行）
tests/                    vitest 自动化测试
```

范围限定：只做对称分量正反换算 + 单相接地故障核算，不含潮流/节点导纳矩阵迭代、前端页面与账户体系。
