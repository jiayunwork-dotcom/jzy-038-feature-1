/**
 * 记录处理引擎：校验 -> 标定归正（调用方参考系 -> 内核参考系）-> 数学内核
 *           -> 标定换回（内核参考系 -> 调用方参考系）-> 组装可留存的记录。
 *
 * 正变换、反变换、故障核算三条路径共用 calibration.ts 中唯一的一组互逆原语，
 * 内核（kernel/transform.ts、kernel/fault.ts）始终只在服务默认参考系下工作、
 * 自身不感知标定。校验不过的记录也原样留存（status=rejected + 结构化错误），
 * 且同样带上本批次冻结的标定快照。
 */

import { Complex } from './complex.js';
import { phasesToSequence as kernelPhasesToSequence, sequenceToPhases as kernelSequenceToPhases } from './kernel/transform.js';
import { calculateSlgFault } from './kernel/fault.js';
import {
  LEGACY_DEFAULT_CALIBRATION,
  forwardPhasesToKernel,
  forwardSequenceFromKernel,
  inversePhasesFromKernel,
  inverseSequenceToKernel,
  phasorFromKernel,
  phasorToKernel,
} from './calibration.js';
import { validateRecord, validateRecordShape } from './validation.js';
import type {
  Calibration,
  FaultRecordInput,
  FaultResultPayload,
  ForwardRecordInput,
  InverseRecordInput,
  PhasorDTO,
  RecordInput,
  RecordResultPayload,
  SequenceDTO,
  StoredRecord,
  ThreePhaseDTO,
  TransformResultPayload,
} from './types.js';

export function polarDTO(c: Complex): PhasorDTO {
  return { magnitude: c.magnitude, angleDeg: c.angleDeg };
}

function phasesDTO(p: { a: Complex; b: Complex; c: Complex }): ThreePhaseDTO {
  return { a: polarDTO(p.a), b: polarDTO(p.b), c: polarDTO(p.c) };
}

function sequenceDTO(s: { zero: Complex; positive: Complex; negative: Complex }): SequenceDTO {
  return { zero: polarDTO(s.zero), positive: polarDTO(s.positive), negative: polarDTO(s.negative) };
}

function toPhasor(p: PhasorDTO): Complex {
  return Complex.polar(p.magnitude, p.angleDeg);
}

function computeTransform(input: ForwardRecordInput | InverseRecordInput, cal: Calibration): TransformResultPayload {
  const phaseMode = input.phaseMode ?? 'phase';
  if (input.direction === 'phase->sequence') {
    // 正变换 P·M（反向时）：输入三相仅按偏移归正（不换 B/C），
    // 内核算出序分量后，输出侧再做 V1/V2 槽位对调与偏移换回。
    const callerPhases = {
      a: toPhasor(input.phases.a),
      b: toPhasor(input.phases.b),
      c: toPhasor(input.phases.c),
    };
    const kernelPhases = forwardPhasesToKernel(callerPhases, cal);
    const kernelSequence = kernelPhasesToSequence(kernelPhases);
    const callerSequence = forwardSequenceFromKernel(kernelSequence, cal);
    return {
      kind: 'transform',
      quantity: input.quantity,
      direction: 'phase->sequence',
      phaseMode,
      phases: phasesDTO(callerPhases),
      sequence: sequenceDTO(callerSequence),
    };
  }
  // 反变换 S·P（反向时）：输入序分量先做 V1/V2 槽位对调与偏移归正，
  // 内核合成矩阵产出的三相即调用方槽位（B/C 不再二次换名），仅偏移换回。
  const callerSequence = {
    zero: toPhasor(input.sequence.zero),
    positive: toPhasor(input.sequence.positive),
    negative: toPhasor(input.sequence.negative),
  };
  const kernelSequence = inverseSequenceToKernel(callerSequence, cal);
  const kernelPhases = kernelSequenceToPhases(kernelSequence);
  const callerPhases = inversePhasesFromKernel(kernelPhases, cal);
  return {
    kind: 'transform',
    quantity: input.quantity,
    direction: 'sequence->phase',
    phaseMode,
    phases: phasesDTO(callerPhases),
    sequence: sequenceDTO(callerSequence),
  };
}

function computeFault(input: FaultRecordInput, cal: Calibration): FaultResultPayload {
  // SLG 故障假定落在 A 相。A 相是 B/C 换名的不动点，I1=I2=I0、Ia=3I0、
  // Va=V0+V1+V2 全部不随「正/负序如何标注」改变，因此方向标定对故障核算
  // 是 no-op（与正/反变换记录共用同一套标定原语的意义在于：偏移角必须一致地
  // 先归正、再换回，故障模块不能只认服务默认零度）。
  //
  // 阻抗是电压/电流之比：公共基准旋转对分子分母同时作用而相消，不随 δ 旋转；
  // vf 为故障点故障前 A 相相电压，按偏移归正进内核。
  const out = calculateSlgFault({
    z1: toPhasor(input.z1),
    z2: toPhasor(input.z2),
    z0: toPhasor(input.z0),
    vf: phasorToKernel(toPhasor(input.vf), cal),
    rf: input.rf ?? 0,
  });

  // 输出全部是 A 相量/三序公共量：只按基准偏移 -δ 换回调用方参考系，不做换名。
  const back = (z: Complex) => phasorFromKernel(z, cal);
  const callerSequenceVoltages = {
    zero: back(out.v0),
    positive: back(out.v1),
    negative: back(out.v2),
  };
  return {
    kind: 'fault',
    z1: input.z1,
    z2: input.z2,
    z0: input.z0,
    vf: input.vf,
    rf: input.rf ?? 0,
    iSequence: polarDTO(back(out.iSequence)),
    faultCurrent: polarDTO(back(out.faultCurrent)),
    sequenceVoltages: sequenceDTO(callerSequenceVoltages),
    faultedPhaseVoltage: polarDTO(back(out.faultedPhaseVoltage)),
    // 跌落为幅值差：公共旋转与 B/C 换名都不改变幅值，内核值即调用方值。
    voltageSag: out.voltageSag,
  };
}

/**
 * 处理一条原始记录：结构/字段校验 + 按批次冻结标定做内核计算。
 * calibration 由批次开立时确定并冻结，引擎不接受记录级覆盖。
 * 返回可直接留存的 StoredRecord（不含 id/批次号，由持久化层补齐），
 * 无论 ok / rejected 都带本批次标定快照，保证逐条可追溯。
 */
export function processRecord(
  raw: unknown,
  calibration: Calibration = LEGACY_DEFAULT_CALIBRATION,
): Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'> {
  const shape = validateRecordShape(raw);
  if (!shape.ok) {
    return { status: 'rejected', input: raw as RecordInput, result: null, errors: shape.errors, calibration: { ...calibration } };
  }
  const input = shape.input;
  const errors = validateRecord(input);
  if (errors.length > 0) {
    return { status: 'rejected', input, result: null, errors, calibration: { ...calibration } };
  }
  try {
    const result: RecordResultPayload = input.kind === 'fault' ? computeFault(input, calibration) : computeTransform(input, calibration);
    return { status: 'ok', input, result, errors: [], calibration: { ...calibration } };
  } catch (err) {
    return {
      status: 'rejected',
      input,
      result: null,
      errors: [{ code: 'VALIDATION_FAILED', field: '$', message: `计算失败: ${(err as Error).message}` }],
      calibration: { ...calibration },
    };
  }
}
