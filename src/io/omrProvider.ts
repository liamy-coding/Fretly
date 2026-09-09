/**
 * 图片/PDF 五线谱 OCR —— 端口 + null 桩（增量设计 §1.5，T-05）。
 *
 * OMR 库选型调研结论（2026-09）：
 *   - Audiveris：桌面 Java，无浏览器/wasm 端口 → 不可用。
 *   - OSMD / Verovio / VexFlow：XML→SVG 渲染器，无 OCR 能力 → 不适用。
 *   - Tesseract.js：通用文字 OCR，不识别五线/符头/符干 → 不可用。
 *   - PlayScore / SheetVision / ScanScore：商业闭源/云端，违反「无后端/无云端」。
 *   - 学术 CRNN OMR（PrIMuS 等）+ tf.js：唯一可行，但需打包 10–50MB 模型、
 *     真实扫描图准确率有限，且与「零采样/小包体积」冲突。
 *
 * 结论：当前不存在「零成本、客户端、可接受精度」的浏览器 OMR 库。
 * 本期只做接口预留 + 管线打通（结果复用 `StaffNote` → `assignFingering` → 编辑器），
 * 不引入任何模型依赖（保包体积），UI 默认不暴露可点入口。
 */
import type { StaffNote } from '@/core/staffFingering';
import { AppError, ERROR_CODES } from '@/core/constants';

export interface OmrResult {
  /** 五线谱音符（与 MusicXML 五线谱路径共用 assignFingering） */
  staffNotes: StaffNote[];
  warnings: string[];
}

export interface OmrProvider {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  recognize(input: Blob | ArrayBuffer): Promise<OmrResult>;
}

/** null 桩：enabled=false，UI 不出现；未来 M2 接真模型时翻转 */
export const nullOmrProvider: OmrProvider = {
  id: 'omr-local',
  label: '图片/PDF 五线谱识别（实验性）',
  enabled: false,
  async recognize(_input: Blob | ArrayBuffer): Promise<OmrResult> {
    throw new AppError(ERROR_CODES.E_NOT_IMPLEMENTED, '图片五线谱识别尚未启用');
  },
};
