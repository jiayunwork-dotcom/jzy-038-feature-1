import type { Complex } from './complex.js';

/** 换算量类型：电压或电流，二者共用同一套对称分量定义与同一个旋转算子 */
export type QuantityType = 'voltage' | 'current';

/**
 * 相序方向标定：
 * - forward：服务默认约定（A 相基准、B 滞后 120°、C 超前 120°，旋转因子取 +120°）；
 * - reverse：调用方把正/负序对调标定，等价于 B、C 两相互换角色。
 */
export type SequenceDirection = 'forward' | 'reverse';

/**
 * 批次标定（开立时冻结，批次存续期不变）：
 * - direction：相序方向；
 * - referenceAngleOffsetDeg：这批数据的零度参考点相对服务默认零度参考点
 *   转过的角度（度）。输入相角先减去它归正再进内核，输出再加回调用方参考系。
 */
export interface Calibration {
  direction: SequenceDirection;
  referenceAngleOffsetDeg: number;
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

export interface CreateBatchInput {
  note?: string;
  /** 批次标定；缺省（字段不存在）时使用服务默认标定，显式传 null 视为非法 */
  calibration?: Calibration;
}

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
  | 'CALIBRATION_FROZEN'
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
  /** 开立时冻结的标定快照（旧数据读出时由持久化层补齐为服务最初的默认标定） */
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
  /** 本批次冻结标定的逐条冗余快照：看任意一条记录即可知当时用的是哪套标定 */
  calibration: Calibration;
}

/** 复数内部表示（实部/虚部），供内核模块使用 */
export type ComplexValue = Complex;
