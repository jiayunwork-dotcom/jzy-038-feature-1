import type { Complex } from './complex.js';

/** 换算量类型：电压或电流，二者共用同一套对称分量定义与同一个旋转算子 */
export type QuantityType = 'voltage' | 'current';

/**
 * 相序标定方向：
 * - forward：服务默认约定（A 相基准，B 滞后 120°，C 超前 120°，旋转因子取 +120°）
 * - reverse：现场反向标定，调用方表述中的正/负序与默认约定对调（等价于 B、C 互换角色）
 */
export type SequenceDirection = 'forward' | 'reverse';

/**
 * 批次级相序标定（开立时指定、开立后冻结）。
 * referenceOffsetDeg：这批数据的零度参考点相对服务默认零度参考点转过的角度（度）。
 * 输入先进服务参考系（相角减去该偏移）再进数学核心，输出再加回该偏移回到调用方参考系。
 */
export interface Calibration {
  readonly direction: SequenceDirection;
  readonly referenceOffsetDeg: number;
}

/** 变换方向：phase->sequence 为正变换，sequence->phase 为反变换 */
export type TransformDirection = 'phase->sequence' | 'sequence->phase';

/** 电压接线：相量（phase，可能含零序）或线量（line，不含零序）。电流恒为相量。 */
export type PhaseMode = 'phase' | 'line';

/** 极坐标相量：有效值（RMS）+ 相角（度） */
export interface PhasorDTO {
  magnitude: number;
  angleDeg: number;
}

/** 一组三相相量，键 a/b/c 对应 A、B、C 三相（线量时对应 Vab/Vbc/Vca） */
export interface ThreePhaseDTO {
  a: PhasorDTO;
  b: PhasorDTO;
  c: PhasorDTO;
}

/** 一组序分量：0 零序、1 正序、2 负序 */
export interface SequenceDTO {
  zero: PhasorDTO;
  positive: PhasorDTO;
  negative: PhasorDTO;
}

/** 正变换记录输入 */
export interface ForwardRecordInput {
  kind: 'transform';
  quantity: QuantityType;
  direction: 'phase->sequence';
  phaseMode?: PhaseMode;
  phases: ThreePhaseDTO;
}

/** 反变换记录输入 */
export interface InverseRecordInput {
  kind: 'transform';
  quantity: QuantityType;
  direction: 'sequence->phase';
  phaseMode?: PhaseMode;
  sequence: SequenceDTO;
}

/** 单相接地故障核算输入（故障假定落在 A 相） */
export interface FaultRecordInput {
  kind: 'fault';
  /** 正序网络阻抗（复数相量表示，实部须为正） */
  z1: PhasorDTO;
  /** 负序网络阻抗 */
  z2: PhasorDTO;
  /** 零序网络阻抗 */
  z0: PhasorDTO;
  /** 故障前 A 相正序电压 */
  vf: PhasorDTO;
  /** 故障点电阻 Rf，可省略（=0 为金属性接地），须非负 */
  rf?: number;
}

export type RecordInput = ForwardRecordInput | InverseRecordInput | FaultRecordInput;

/** 非法输入的单条字段错误 */
export interface FieldError {
  code: ErrorCode;
  field: string;
  message: string;
}

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'MISSING_PHASE'
  | 'MAGNITUDE_NON_POSITIVE'
  | 'ANGLE_NOT_FINITE'
  | 'IMPEDANCE_NON_POSITIVE'
  | 'FAULT_IMPEDANCE_NON_POSITIVE'
  | 'LINE_ZERO_SEQUENCE_NOT_ZERO'
  | 'LINE_MODE_NOT_APPLICABLE_TO_CURRENT'
  | 'MALFORMED_PHASOR'
  | 'CALIBRATION_INVALID'
  | 'CALIBRATION_OFFSET_NOT_FINITE'
  | 'CALIBRATION_DIRECTION_INVALID'
  | 'CALIBRATION_MALFORMED'
  | 'BATCH_CALIBRATION_FROZEN'
  | 'BATCH_NOT_FOUND'
  | 'RECORD_NOT_FOUND'
  | 'UNSUPPORTED_RECORD';

/** 变换记录的核算结果 */
export interface TransformResultPayload {
  kind: 'transform';
  quantity: QuantityType;
  direction: TransformDirection;
  phaseMode: PhaseMode;
  phases: ThreePhaseDTO;
  sequence: SequenceDTO;
}

/** 故障核算结果 */
export interface FaultResultPayload {
  kind: 'fault';
  z1: PhasorDTO;
  z2: PhasorDTO;
  z0: PhasorDTO;
  vf: PhasorDTO;
  rf: number;
  /** 三序串联回路中的序电流 I1=I2=I0 */
  iSequence: PhasorDTO;
  /** 故障相（A 相）故障电流 = 3 I0 */
  faultCurrent: PhasorDTO;
  /** 故障相序网电压：正序/负序/零序在故障点处的电压 */
  sequenceVoltages: SequenceDTO;
  /** 故障相（A 相）电压 */
  faultedPhaseVoltage: PhasorDTO;
  /** 故障相电压跌落（幅值，标幺同 vf 的量纲）：|Vf|-|Va| */
  voltageSag: number;
}

export type RecordResultPayload = TransformResultPayload | FaultResultPayload;

export type RecordStatus = 'ok' | 'rejected';

export interface Batch {
  id: string;
  createdAt: string;
  note: string | null;
  /** 开立时冻结的标定快照；批次存续期间所有记录都使用这一套，不受服务默认标定变化影响 */
  calibration: Calibration;
}

export interface StoredRecord {
  id: string;
  batchId: string;
  index: number;
  createdAt: string;
  status: RecordStatus;
  input: RecordInput;
  result: RecordResultPayload | null;
  errors: FieldError[];
  /** 本条记录实际使用的标定（= 批次冻结标定的快照），事后回看任意记录都可辨认口径 */
  calibration: Calibration;
}

/** 复数内部表示（实部/虚部），供内核模块使用 */
export type ComplexValue = Complex;
