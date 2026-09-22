/**
 * 相序标定（calibration）：批次级配置 + 全服务唯一的标定下水点。
 *
 * 标定含两层，且两层可以任意组合：
 *
 *   1. 相序方向 direction：
 *      - forward：服务钉死的默认约定（A 基准、B 滞后 120°、C 超前 120°，a = e^{j·120°}）；
 *      - reverse：现场反向标定，调用方口中的"正序"即默认约定下的负序（等价 B、C 互换角色）。
 *
 *   2. 基准相角偏移 referenceOffsetDeg（记 δ）：
 *      调用方参考系的零度相对服务默认零度转过 δ。所有输入相量先进服务参考系
 *      （相角减 δ，即乘 e^{-jδ}）再交给数学核心；所有核心输出再乘 e^{+jδ}
 *      换回调用方参考系。调用方不需要在服务外手动搬角度。
 *
 * 关键约束：正变换、反变换、故障核算三处都必须经过这里的同一个 CalibratedEngine，
 * 不允许各自再实现一份换算 —— 否则会出现同批次结果互相对不上、反标定后回不到原值。
 *
 * 数学核心（kernel/）始终只认服务默认约定，本模块是核心外围唯一的参考系适配层。
 * 数学上严格可逆：正向标定与反向标定仅差一个 B/C 置换（自逆），角度旋转与其逆角
 * 互逆，二者组合后 forward→inverse 必在浮点容差内精确还原任意三相输入。
 *
 * 兼容性：标定能力上线前的旧批次没有标定字段，一律按服务当初唯一支持的默认标定
 * 认定（forward / 0°），见 resolveStoredCalibration 的宽容解析；δ=0 时本层走恒等
 * 快路径直接返回原复数，旧批次数值与升级前逐位一致（非仅容差一致）。
 */

import { Complex } from './complex.js';
import { phasesToSequence, sequenceToPhases } from './kernel/transform.js';
import type { PhaseTriplet, SequenceTriplet } from './kernel/transform.js';
import { calculateSlgFault } from './kernel/fault.js';
import type { FaultInputs, FaultOutputs } from './kernel/fault.js';
import type {
  Calibration,
  FieldError,
  SequenceDirection,
} from './types.js';

/** 服务默认标定：正向、零偏移。能力上线前的旧批次一律按此认定。 */
export const DEFAULT_CALIBRATION: Calibration = Object.freeze({
  direction: 'forward',
  referenceOffsetDeg: 0,
});

/** 构造一份标定（组件测试与仓储内部使用；开立 HTTP 请求走 parseCalibrationRequest 严格校验） */
export function makeCalibration(direction: SequenceDirection = 'forward', referenceOffsetDeg = 0): Calibration {
  return Object.freeze({ direction, referenceOffsetDeg });
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 解析开立批次时提交的标定（严格）：
 * - calibration 整体缺省 / 各字段缺省 -> 取服务默认；
 * - 结构必须是对象；direction 只允许 forward / reverse；
 * - referenceOffsetDeg 必须是有限数值（NaN/Infinity/字符串一律拒绝）。
 * 非法时返回结构化字段错误（调用方据此拒绝开立，不产生批次）。
 */
export function parseCalibrationRequest(raw: unknown):
  | { ok: true; calibration: Calibration }
  | { ok: false; errors: FieldError[] } {
  if (raw === undefined || raw === null) {
    return { ok: true, calibration: DEFAULT_CALIBRATION };
  }
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      errors: [
        {
          code: 'CALIBRATION_MALFORMED',
          field: 'calibration',
          message: 'calibration 必须是对象 { direction?: "forward"|"reverse", referenceOffsetDeg?: number }',
        },
      ],
    };
  }

  const errors: FieldError[] = [];

  let direction: SequenceDirection = DEFAULT_CALIBRATION.direction;
  if (raw.direction !== undefined) {
    if (raw.direction !== 'forward' && raw.direction !== 'reverse') {
      errors.push({
        code: 'CALIBRATION_DIRECTION_INVALID',
        field: 'calibration.direction',
        message: `calibration.direction 只支持 forward（默认约定）或 reverse（正负序对调），收到 ${String(raw.direction)}`,
      });
    } else {
      direction = raw.direction;
    }
  }

  let referenceOffsetDeg = DEFAULT_CALIBRATION.referenceOffsetDeg;
  if (raw.referenceOffsetDeg !== undefined) {
    if (typeof raw.referenceOffsetDeg !== 'number' || !Number.isFinite(raw.referenceOffsetDeg)) {
      errors.push({
        code: 'CALIBRATION_OFFSET_NOT_FINITE',
        field: 'calibration.referenceOffsetDeg',
        message: `calibration.referenceOffsetDeg 必须是有限数值（度），收到 ${String(raw.referenceOffsetDeg)}`,
      });
    } else {
      referenceOffsetDeg = raw.referenceOffsetDeg;
    }
  }

  // 出现未被识别的额外键也明确拒绝，避免调用方误以为写了别的生效
  for (const key of Object.keys(raw)) {
    if (key !== 'direction' && key !== 'referenceOffsetDeg') {
      errors.push({
        code: 'CALIBRATION_INVALID',
        field: `calibration.${key}`,
        message: `calibration 含未知字段 calibration.${key}，只支持 direction / referenceOffsetDeg`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, calibration: makeCalibration(direction, referenceOffsetDeg) };
}

/** 从开立请求体中取出 calibration 原始片段（供路由层调用严格解析） */
export function pickCalibrationRequest(body: unknown): unknown {
  return isPlainRecord(body) ? body.calibration : undefined;
}

/**
 * 宽容解析已持久化的标定：旧批次/旧记录在能力上线前写入，行内根本没有标定信息，
 * 必须认定为服务当初唯一支持的默认标定（forward / 0°），不得成为"标定不明"的孤儿数据。
 * 对缺损方向或非有限偏移的历史脏数据同样回落到默认，保证升级不是破坏性变更。
 */
export function resolveStoredCalibration(stored: unknown): Calibration {
  if (!isPlainRecord(stored)) return DEFAULT_CALIBRATION;
  const direction = stored.direction === 'forward' || stored.direction === 'reverse'
    ? (stored.direction as SequenceDirection)
    : DEFAULT_CALIBRATION.direction;
  const offset = typeof stored.referenceOffsetDeg === 'number' && Number.isFinite(stored.referenceOffsetDeg)
    ? stored.referenceOffsetDeg
    : DEFAULT_CALIBRATION.referenceOffsetDeg;
  if (direction === DEFAULT_CALIBRATION.direction && offset === DEFAULT_CALIBRATION.referenceOffsetDeg) {
    return DEFAULT_CALIBRATION;
  }
  return makeCalibration(direction, offset);
}

/**
 * 标定引擎：数学核心外围唯一的参考系适配层。
 * 同一批次的正变换、反变换、故障核算共用同一个实例（同一套方向对调与角度偏移）。
 */
export class CalibratedEngine {
  /** 调用方参考系 -> 服务参考系：乘 e^{-jδ}。δ=0 时恒等快路径（位级等价，旧批次零影响）。 */
  private readonly toService: (z: Complex) => Complex;
  /** 服务参考系 -> 调用方参考系：乘 e^{+jδ}，toService 的严格逆。 */
  private readonly toCaller: (z: Complex) => Complex;

  constructor(readonly calibration: Calibration) {
    const delta = calibration.referenceOffsetDeg;
    if (delta === 0) {
      this.toService = (z) => z;
      this.toCaller = (z) => z;
    } else {
      const shiftIn = Complex.polar(1, -delta);
      const shiftOut = Complex.polar(1, delta);
      this.toService = (z) => z.mul(shiftIn);
      this.toCaller = (z) => z.mul(shiftOut);
    }
  }

  /** 相量从调用方参考系归正到服务参考系（相角减基准偏移）。供跨批次/对外参考系换算使用。 */
  toServiceFrame(z: Complex): Complex {
    return this.toService(z);
  }

  /** 相量从服务参考系换回调用方参考系（相角加回基准偏移），toServiceFrame 的严格逆。 */
  toCallerFrame(z: Complex): Complex {
    return this.toCaller(z);
  }

  /**
   * 正变换（三相 -> 序），入参与出参均在调用方参考系、按调用方标定命名序分量。
   *
   * 物理端子 A/B/C 不随标定改变；reverse 标定只改变序分量槽位的命名：
   * 调用方所说的"正序"在服务约定下是负序（等价于 B、C 互换角色的现场接线），
   * 故 reverse 时把核心产出的正/负槽对调后再贴调用方标签（零序不受方向影响）。
   * 注意：标签对调与端子对调是同一个映射的两种表述，只能做一次，不能两边都做。
   */
  phasesToSequence(input: PhaseTriplet): SequenceTriplet {
    const inService: PhaseTriplet = {
      a: this.toService(input.a),
      b: this.toService(input.b),
      c: this.toService(input.c),
    };
    const core = phasesToSequence(inService);
    if (this.calibration.direction === 'reverse') {
      return {
        zero: this.toCaller(core.zero),
        positive: this.toCaller(core.negative),
        negative: this.toCaller(core.positive),
      };
    }
    return {
      zero: this.toCaller(core.zero),
      positive: this.toCaller(core.positive),
      negative: this.toCaller(core.negative),
    };
  }

  /**
   * 反变换（序 -> 三相），入参与出参均在调用方参考系、按调用方标定命名序分量。
   * reverse 时把调用方序量按标签反向放进核心槽位（他的正序 -> 核心负序槽），
   * 与 phasesToSequence 是同一置换的逆；合成出的 A/B/C 即调用方端子，不再二次对调。
   */
  sequenceToPhases(input: SequenceTriplet): PhaseTriplet {
    const inService: SequenceTriplet = {
      zero: this.toService(input.zero),
      positive: this.toService(this.calibration.direction === 'reverse' ? input.negative : input.positive),
      negative: this.toService(this.calibration.direction === 'reverse' ? input.positive : input.negative),
    };
    const core = sequenceToPhases(inService);
    return {
      a: this.toCaller(core.a),
      b: this.toCaller(core.b),
      c: this.toCaller(core.c),
    };
  }

  /**
   * 单相接地故障核算，所有相量入参/出参均在调用方参考系。
   *
   * 偏移 δ：电压、电流是相量（进核心减 δ，出核心加 δ）；阻抗是不随参考零点旋转的
   * 比值量，rf 与跌落为标量，均保持不变。
   *
   * reverse 标定：故障落在 A 相（端子 A 不参与 B/C 对调）。z1/z2/vf 是调用方在
   * 自己的序坐标系里按标签给出的 —— 他的"正序网"就是带驱动源 Vf 的那个网，
   * 核心方程是对槽位 1（驱动网）的坐标模板，槽位按标签恒等映射即可，无需对调。
   * 三序串联电流 I1=I2=I0 对 1↔2 更名不变；故障相电流/电压是 A 相量，不受更名影响。
   * 一致性由同一标定下的反变换保证：把输出的序电压用同一引擎反变换回三相，
   * Va = V0+V1+V2（和与更名无关）= 3Rf·I。
   */
  calculateFault(input: FaultInputs): FaultOutputs {
    const inService: FaultInputs = {
      z1: input.z1,
      z2: input.z2,
      z0: input.z0,
      vf: this.toService(input.vf),
      rf: input.rf,
    };
    const core = calculateSlgFault(inService);
    return {
      iSequence: this.toCaller(core.iSequence),
      faultCurrent: this.toCaller(core.faultCurrent),
      v1: this.toCaller(core.v1),
      v2: this.toCaller(core.v2),
      v0: this.toCaller(core.v0),
      faultedPhaseVoltage: this.toCaller(core.faultedPhaseVoltage),
      voltageSag: core.voltageSag,
    };
  }
}
