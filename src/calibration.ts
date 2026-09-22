/**
 * 批次标定层：调用方参考系 ⇄ 数学内核参考系之间唯一的一套换算原语。
 *
 * 标定包含两件事：
 *
 * 1. 相序方向 direction（正/负序标定对调，等价于 B、C 互换角色）：
 *    - forward（默认）：正序 A∠0°、B∠-120°、C∠+120°（内核原生约定）；
 *    - reverse：调用方把正/负序对调标定。
 *
 *    记 M 为内核正变换、S=M⁻¹ 为反变换、P 为换名（三相侧换 B/C；
 *    序域侧换 V1/V2 槽位；零序/ A 相不动，P²=I）。反向批次的配对变换是
 *
 *      正变换（三相 -> 序）：  y = P·M·x     —— 输出序分量做 V1/V2 换名
 *      反变换（序 -> 三相）：  x = S·P·y     —— 输入序分量做 V1/V2 换名
 *
 *    于是同一组三相在两个批次下严格有
 *
 *      reverse.V1 = forward.V2，  reverse.V2 = forward.V1，  V0 相同，
 *
 *    而正反配对仍严格互逆：P·M·S·P = P·P = I（双向闭合，浮点容差内）。
 *    注意不能用「两侧对称地都换名」的 P·M·P —— 对对称分量矩阵 P·M·P 恰等于 M，
 *    那样虽然闭合但没有任何标定效果；也不能只在单侧换名，那样正反不再互逆。
 *
 * 2. 基准相角偏移 referenceAngleOffsetDeg（δ，度）：
 *    调用方参考系的零度轴相对内核零度轴沿正方向转过 δ，即
 *
 *      z_kernel = e^{+jδ}·z_caller ，  z_caller = e^{-jδ}·z_kernel。
 *
 *    进内核的相量整体旋转 +δ（归正），内核输出再整体旋转 -δ（换回）。
 *    旋转矩阵与 M/S 可交换，因此与换名、正反变换任意复合都保持可逆。
 *
 * 正变换、反变换、故障核算三条路径都只能经过本模块的原语进出内核，
 * 不允许任何一处另写一份角度/换名逻辑。
 */

import { Complex } from './complex.js';
import type { Calibration, FieldError, SequenceDirection } from './types.js';

/**
 * 服务「最初唯一支持」的标定：正向、零偏移。
 * 标定可配置能力上线前建立的旧批次、旧记录一律按这套标定解释，
 * 不随后续服务默认标定的改变而漂移。
 */
export const LEGACY_DEFAULT_CALIBRATION: Calibration = Object.freeze({
  direction: 'forward',
  referenceAngleOffsetDeg: 0,
});

/** 正向 + 零偏移即恒等标定：走快通道时结果与无标定时代逐位一致 */
export function isIdentityCalibration(cal: Calibration): boolean {
  return cal.direction === 'forward' && cal.referenceAngleOffsetDeg === 0;
}

/** 校验调用方在开立批次时提交的标定；字段缺省（undefined）回落到默认值 */
export function parseCalibrationSpec(
  raw: unknown,
  fallback: Calibration,
): { ok: true; calibration: Calibration } | { ok: false; errors: FieldError[] } {
  if (raw === undefined) return { ok: true, calibration: fallback };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          code: 'CALIBRATION_INVALID',
          field: 'calibration',
          message: 'calibration 必须是 { direction?: "forward"|"reverse", referenceAngleOffsetDeg?: number }',
        },
      ],
    };
  }
  const spec = raw as { direction?: unknown; referenceAngleOffsetDeg?: unknown };
  const errors: FieldError[] = [];

  let direction: SequenceDirection = fallback.direction;
  if (spec.direction !== undefined) {
    if (spec.direction !== 'forward' && spec.direction !== 'reverse') {
      errors.push({
        code: 'CALIBRATION_INVALID',
        field: 'calibration.direction',
        message: `calibration.direction 只能是 forward 或 reverse，收到 ${String(spec.direction)}`,
      });
    } else {
      direction = spec.direction;
    }
  }

  let offsetDeg = fallback.referenceAngleOffsetDeg;
  if (spec.referenceAngleOffsetDeg !== undefined) {
    const v = spec.referenceAngleOffsetDeg;
    // 必须是有限数：NaN / Infinity / -Infinity / 字符串 / null 一律在开立阶段拒绝
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push({
        code: 'CALIBRATION_OFFSET_NOT_FINITE',
        field: 'calibration.referenceAngleOffsetDeg',
        message: `calibration.referenceAngleOffsetDeg 必须是有限数值（度），收到 ${String(v)}`,
      });
    } else {
      offsetDeg = v;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, calibration: { direction, referenceAngleOffsetDeg: offsetDeg } };
}

/** 从持久化行恢复标定；旧数据（null/缺字段）一律认定为服务最初的默认标定 */
export function resolveStoredCalibration(row: unknown): Calibration {
  if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
    const r = row as { direction?: unknown; referenceAngleOffsetDeg?: unknown };
    const direction = r.direction === 'reverse' ? 'reverse' : r.direction === 'forward' ? 'forward' : LEGACY_DEFAULT_CALIBRATION.direction;
    const offset =
      typeof r.referenceAngleOffsetDeg === 'number' && Number.isFinite(r.referenceAngleOffsetDeg)
        ? r.referenceAngleOffsetDeg
        : LEGACY_DEFAULT_CALIBRATION.referenceAngleOffsetDeg;
    return { direction, referenceAngleOffsetDeg: offset };
  }
  return LEGACY_DEFAULT_CALIBRATION;
}

/* ------------------------------------------------------------------ */
/* 内核参考系 ⇄ 调用方参考系：互逆原语（全服务唯一一份）                 */
/* ------------------------------------------------------------------ */

function rot(c: Complex, deltaDeg: number): Complex {
  // 单位相量做纯相位旋转：直接用三角展开，避免多一次极坐标往返
  const rad = (deltaDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return new Complex(c.re * cos - c.im * sin, c.re * sin + c.im * cos);
}

type Triplet = Record<string, Complex>;

function rotateTriplet<T extends Triplet>(t: T, deltaDeg: number): T {
  const out: Triplet = {};
  for (const [k, v] of Object.entries(t)) out[k] = rot(v, deltaDeg);
  return out as T;
}

/* ---- 单相量（如故障点 A 相电压/电流）：只有基准偏移，不参与 B/C 换名 ---- */

/** 单个相量：调用方 -> 内核（角归正 +δ） */
export function phasorToKernel(z: Complex, cal: Calibration): Complex {
  if (isIdentityCalibration(cal)) return z;
  return cal.referenceAngleOffsetDeg === 0 ? z : rot(z, cal.referenceAngleOffsetDeg);
}

/** 单个相量：内核 -> 调用方（角换回 -δ） */
export function phasorFromKernel(z: Complex, cal: Calibration): Complex {
  if (isIdentityCalibration(cal)) return z;
  return cal.referenceAngleOffsetDeg === 0 ? z : rot(z, -cal.referenceAngleOffsetDeg);
}

/* ---- 三相相量 ---- */

/**
 * 正变换输入：调用方三相 -> 内核三相。
 * 方向对调体现在序输出侧（P·M），输入三相不换 B/C；仅做基准旋转 +δ。
 */
export function forwardPhasesToKernel(
  p: { a: Complex; b: Complex; c: Complex },
  cal: Calibration,
): { a: Complex; b: Complex; c: Complex } {
  if (isIdentityCalibration(cal) || cal.referenceAngleOffsetDeg === 0) return p;
  return rotateTriplet(p, cal.referenceAngleOffsetDeg);
}

/**
 * 反变换输出：内核三相 -> 调用方三相。
 * 配对反变换是 S·P（换名只作用在序输入侧），合成矩阵 S 的 B/C 行本身已含
 * a²/a 系数，输出三相按调用方槽位原样排列即可，这里不再换 B/C —— 仅旋转 -δ。
 */
export function inversePhasesFromKernel(
  p: { a: Complex; b: Complex; c: Complex },
  cal: Calibration,
): { a: Complex; b: Complex; c: Complex } {
  if (isIdentityCalibration(cal) || cal.referenceAngleOffsetDeg === 0) return p;
  return rotateTriplet(p, -cal.referenceAngleOffsetDeg);
}

/* ---- 序分量 ---- */

/**
 * 正变换输出：内核序分量 -> 调用方序分量（P·M 的输出侧）。
 * 反向标定时正/负序槽位互换，再整体旋转 -δ；零序只随偏移旋转。
 */
export function forwardSequenceFromKernel(
  s: { zero: Complex; positive: Complex; negative: Complex },
  cal: Calibration,
): { zero: Complex; positive: Complex; negative: Complex } {
  if (isIdentityCalibration(cal)) return s;
  const swapped = cal.direction === 'reverse' ? { zero: s.zero, positive: s.negative, negative: s.positive } : s;
  if (cal.referenceAngleOffsetDeg === 0) return swapped;
  return rotateTriplet(swapped, -cal.referenceAngleOffsetDeg);
}

/**
 * 反变换输入：调用方序分量 -> 内核序分量（S·P 的输入侧）。
 * 反向标定时正/负序槽位互换，再整体旋转 +δ；零序只随偏移旋转。
 */
export function inverseSequenceToKernel(
  s: { zero: Complex; positive: Complex; negative: Complex },
  cal: Calibration,
): { zero: Complex; positive: Complex; negative: Complex } {
  if (isIdentityCalibration(cal)) return s;
  const swapped = cal.direction === 'reverse' ? { zero: s.zero, positive: s.negative, negative: s.positive } : s;
  if (cal.referenceAngleOffsetDeg === 0) return swapped;
  return rotateTriplet(swapped, cal.referenceAngleOffsetDeg);
}
