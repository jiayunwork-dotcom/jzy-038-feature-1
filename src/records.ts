/**
 * 记录处理引擎：校验 -> 标定归正 -> 调用变换/故障内核 -> 标定换回 -> 组装可留存的记录。
 * 校验不过的记录也原样留存（status=rejected + 结构化错误），不抛异常给调用方。
 *
 * 标定处理只有这一处下水：正变换、反变换、故障核算都使用由当批冻结标定构造的
 * 同一个 CalibratedEngine，任何记录都不允许绕过它直连数学核心。
 */

import { Complex } from './complex.js';
import { CalibratedEngine, DEFAULT_CALIBRATION } from './calibration.js';
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

function computeTransform(
  input: ForwardRecordInput | InverseRecordInput,
  engine: CalibratedEngine,
): TransformResultPayload {
  const phaseMode = input.phaseMode ?? 'phase';
  if (input.direction === 'phase->sequence') {
    const phasesC = {
      a: Complex.polar(input.phases.a.magnitude, input.phases.a.angleDeg),
      b: Complex.polar(input.phases.b.magnitude, input.phases.b.angleDeg),
      c: Complex.polar(input.phases.c.magnitude, input.phases.c.angleDeg),
    };
    const seqC = engine.phasesToSequence(phasesC);
    return {
      kind: 'transform',
      quantity: input.quantity,
      direction: 'phase->sequence',
      phaseMode,
      phases: phasesDTO(phasesC),
      sequence: sequenceDTO(seqC),
    };
  }
  const seqC = {
    zero: Complex.polar(input.sequence.zero.magnitude, input.sequence.zero.angleDeg),
    positive: Complex.polar(input.sequence.positive.magnitude, input.sequence.positive.angleDeg),
    negative: Complex.polar(input.sequence.negative.magnitude, input.sequence.negative.angleDeg),
  };
  const phasesC = engine.sequenceToPhases(seqC);
  return {
    kind: 'transform',
    quantity: input.quantity,
    direction: 'sequence->phase',
    phaseMode,
    phases: phasesDTO(phasesC),
    sequence: sequenceDTO(seqC),
  };
}

function computeFault(input: FaultRecordInput, engine: CalibratedEngine): FaultResultPayload {
  const out = engine.calculateFault({
    z1: Complex.polar(input.z1.magnitude, input.z1.angleDeg),
    z2: Complex.polar(input.z2.magnitude, input.z2.angleDeg),
    z0: Complex.polar(input.z0.magnitude, input.z0.angleDeg),
    vf: Complex.polar(input.vf.magnitude, input.vf.angleDeg),
    rf: input.rf ?? 0,
  });
  return {
    kind: 'fault',
    z1: input.z1,
    z2: input.z2,
    z0: input.z0,
    vf: input.vf,
    rf: input.rf ?? 0,
    iSequence: polarDTO(out.iSequence),
    faultCurrent: polarDTO(out.faultCurrent),
    sequenceVoltages: {
      zero: polarDTO(out.v0),
      positive: polarDTO(out.v1),
      negative: polarDTO(out.v2),
    },
    faultedPhaseVoltage: polarDTO(out.faultedPhaseVoltage),
    voltageSag: out.voltageSag,
  };
}

/**
 * 处理一条原始记录：结构/字段校验 + 当批标定下的内核计算。
 * 返回可直接留存的 StoredRecord（不含 id/批次号，由持久化层补齐），其中带当批标定快照。
 */
export function processRecord(
  raw: unknown,
  calibration: Calibration = DEFAULT_CALIBRATION,
): Omit<StoredRecord, 'id' | 'batchId' | 'index' | 'createdAt'> {
  const shape = validateRecordShape(raw);
  if (!shape.ok) {
    return { status: 'rejected', input: raw as RecordInput, result: null, errors: shape.errors, calibration };
  }
  const input = shape.input;
  const errors = validateRecord(input, calibration);
  if (errors.length > 0) {
    return { status: 'rejected', input, result: null, errors, calibration };
  }
  try {
    // 同一批次的正变换/反变换/故障核算共用这一个标定引擎实例
    const engine = new CalibratedEngine(calibration);
    const result: RecordResultPayload = input.kind === 'fault'
      ? computeFault(input, engine)
      : computeTransform(input, engine);
    return { status: 'ok', input, result, errors: [], calibration };
  } catch (err) {
    return {
      status: 'rejected',
      input,
      result: null,
      errors: [{ code: 'VALIDATION_FAILED', field: '$', message: `计算失败: ${(err as Error).message}` }],
      calibration,
    };
  }
}
