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

### 批次标定（相序方向 + 基准相角偏移）

不同变电站、不同厂商的二次设备对"哪个是正序"以及零度参考点的标定习惯不一致。本服务把标定从内部唯一写死的默认值，提升为**开立批次时挑选、开立后冻结**的批次级配置：

- `direction`：相序方向。
  - `forward`（默认）：沿用上面的服务约定；
  - `reverse`：调用方把正、负序对调标定（等价于 B、C 两相互换角色）。同组三相在 forward / reverse 两个批次下正变换的 V1、V2 **正好互换**，V0 不受影响。
- `referenceAngleOffsetDeg`：基准相角偏移 δ（度，任意有限角度）。该批数据的零度参考轴相对服务默认零度轴转过 δ；换算时先在内部把输入归正（+δ）再进数学内核，输出再换回调用方参考系（−δ）。纯参考系平移对换算是不变量——调用方不需要在服务外手动搬角度；δ 的价值在于统一归正口径、随批次留痕、可追溯。

实现要点（避免"只套一层壁纸"）：

- 正变换、反变换、故障核算**共用 `src/calibration.ts` 中唯一的一组互逆原语**进出内核，数学内核本身不感知标定；
- 方向对调的配对矩阵为正变换 `P·M`、反变换 `S·P`（P 为 V1/V2 换名，M/S 为内核正/反变换），二者乘积为 I —— 任意三相在同一批次内先正再反（或先反再正），在 `1e-9` 容差内精确还原，与方向、偏移无关；
- 故障假定落在 A 相（B/C 换名的不动点），因此方向标定对故障结果无数值影响，但**偏移角与变换记录走同一套归正/换回**，故障模块不会只认默认零度；
- 标定在**批次开立时快照冻结**：批次与每条记录（含被拒绝记录）都持久化标定快照，看任意一条记录即可知当时用的哪套标定；之后即使服务默认标定改变，已开批次不受影响；
- 升级前建立的旧批次/旧记录没有标定信息，读出时一律认定为服务当初唯一支持的默认标定（forward / 0），数据库迁移会把该默认值显式回填旧行；零偏移/正向走恒等快通道，旧批次新老结果**逐位一致**，升级不是隐性破坏性变更。

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
| POST | `/batches` | 开立批次（可携带 `calibration`，缺省用服务默认标定） |
| PATCH/PUT | `/batches/:id` | 批次标定为冻结项：任何标定修改一律 409 拒绝 |
| POST | `/batches/:id/records` | 投入一条（对象）或多条（数组）记录 |
| GET  | `/batches/:id` | 查批次（含全部记录） |
| GET  | `/batches/:id/records` | 取批次内全部记录 |
| GET  | `/batches/:id/records/:rid` | 只取一条记录 |
| GET  | `/health` | 健康检查 |

每条记录都留存：原始输入、输出结果、变换方向、状态（`ok`/`rejected`）、结构化错误以及**本批次冻结的标定快照**。**校验不过的记录也入库**（单条投递返回 422，批量投递返回 200、逐条标状态），不会被悄悄丢弃。

### 开立批次与标定

```bash
# 不指定标定：快照服务默认（环境变量未配置时即 forward / 0，与历史行为一致）
curl -s -X POST localhost:8080/batches -H 'content-type: application/json' -d '{"note":"demo"}'

# 指定反向标定 + 30° 基准偏移
curl -s -X POST localhost:8080/batches -H 'content-type: application/json' -d '{
  "note": "substation-X reverse wired",
  "calibration": { "direction": "reverse", "referenceAngleOffsetDeg": 30 }
}'
# -> {"id":"<BATCH_ID>", "calibration":{"direction":"reverse","referenceAngleOffsetDeg":30}, ...}
```

`calibration` 字段可整体省略（用默认），也可只给其中一项（另一项回落默认）。开立后该标定**冻结**：

```bash
curl -s -X PATCH localhost:8080/batches/<BATCH_ID> -H 'content-type: application/json' \
  -d '{"calibration":{"direction":"forward","referenceAngleOffsetDeg":0}}'
# -> 409 {"error":{"code":"CALIBRATION_FROZEN", ...}}
```

非法标定在开立阶段即被结构化拒绝（`400`），不产生批次：偏移为 `NaN`/`Infinity`/字符串/`null` → `CALIBRATION_OFFSET_NOT_FINITE`；方向非 `forward`/`reverse`、标定整体非对象 → `CALIBRATION_INVALID`。

服务默认标定可由环境变量覆盖（仅影响之后新开、且未显式指定标定的批次，不追溯旧批次）：
`DEFAULT_SEQUENCE_DIRECTION`（`forward`/`reverse`）、`DEFAULT_REFERENCE_ANGLE_OFFSET_DEG`（有限数值）。

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

错误类型：`MAGNITUDE_NON_POSITIVE` / `MISSING_PHASE` / `ANGLE_NOT_FINITE` / `MALFORMED_PHASOR` / `IMPEDANCE_NON_POSITIVE` / `FAULT_IMPEDANCE_NON_POSITIVE` / `LINE_ZERO_SEQUENCE_NOT_ZERO` / `LINE_MODE_NOT_APPLICABLE_TO_CURRENT` / `CALIBRATION_INVALID` / `CALIBRATION_OFFSET_NOT_FINITE` / `CALIBRATION_FROZEN` / `BATCH_NOT_FOUND` / `RECORD_NOT_FOUND` / `VALIDATION_FAILED` / `UNSUPPORTED_RECORD`。

---

## 3. 本地开发与测试

```bash
npm ci
npm test          # vitest，内核 + 校验 + 标定 + HTTP + 并发
npm run build     # tsc -> dist/
npm start         # 默认内存存储，:8080
STORAGE=postgres DATABASE_URL=postgres://symcomp:symcomp@localhost:5432/symcomp npm start
```

测试覆盖的标定关系：

- **标定正反闭合**：随机三相/随机序量，在 forward/reverse × 多个偏移角（含负角、超大角）的组合下双向闭合到机器精度；
- **方向对调**：同组三相 forward / reverse 两批次 V1、V2 互换、V0 相同；平衡正序在反向批次被认定为纯负序；
- **跨模块一致**：故障批次的序网电压/序电流经同批次反变换，A 相分别等于故障相电压/故障相电流；方向标定不改变 A 相故障结果；
- **旧数据兼容**：持久化层对标定列 NULL/缺省的旧行一律补成历史默认标定；恒等标定走快通道，旧批次重算逐位一致；
- **合法性把关**：偏移 NaN/Infinity/非数字、方向非法、标定非对象在开立阶段 400 拒绝且不产生批次；已开立批次 PATCH/PUT 标定返回 409 `CALIBRATION_FROZEN` 且原值不变；
- **冻结与留痕**：记录级私带标定字段被忽略；ok / rejected 记录都带批次冻结标定快照。

测试覆盖的物理关系：

- **正反闭合**：随机三相 / 随机序量双向闭合；`A·S=I` 矩阵互逆；
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

环境变量：`STORAGE`（`postgres`/`memory`）、`DATABASE_URL`、`PORT`、`HOST`、`DEFAULT_SEQUENCE_DIRECTION`（`forward`/`reverse`）、`DEFAULT_REFERENCE_ANGLE_OFFSET_DEG`（默认标定偏移，有限数值）。后两者只在新开批次未显式指定标定时生效。

## 5. 模块结构（按职责拆分）

```
src/
  complex.ts              复数运算 + 旋转算子 a（唯一一份）
  calibration.ts          批次标定：开立校验/冻结快照 + 参考系互逆原语（唯一一份）
  types.ts                对外/对内数据模型与错误类型
  validation.ts           带类型的输入校验
  records.ts              记录处理引擎（校验 -> 标定归正 -> 内核 -> 标定换回 -> 留存）
  app.ts                  Fastify 装配与统一错误处理
  server.ts               入口与存储选择
  config.ts               环境配置（含服务默认标定）
  kernel/
    transform.ts          正反变换内核（合成矩阵 + 其逆，不感知标定）
    fault.ts              单相接地序网核算内核（不感知标定）
  routes/
    records.ts            HTTP 路由（批次开立/标定冻结/记录）
  persistence/
    repository.ts         仓储接口
    memory.ts             内存实现（测试/默认）
    postgres.ts           PostgreSQL 实现（旧行标定缺省自动补齐）
  db/migrate.ts           建表与标定列增量迁移（幂等）
tests/                    vitest 自动化测试
```

范围限定：只做对称分量正反换算 + 单相接地故障核算，不含潮流/节点导纳矩阵迭代、前端页面与账户体系。
