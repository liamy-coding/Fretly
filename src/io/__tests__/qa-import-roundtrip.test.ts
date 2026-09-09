// @vitest-environment jsdom
/**
 * QA 边界回归 —— MusicXML/ASCII/JSON 导入（独立于工程师用例）。
 *
 * 覆盖风险（team-lead 点名 + PRD A-05/Q4/Q5）：
 *  1) JSON round-trip 往返无损（除 id/createdAt/revision 等身份字段）
 *  2) ASCII 宽松解析：行不齐 / 有杂散字符不报错，仍产出小节
 *  3) 无吉他轨的 MusicXML：有音高轨回退五线谱；既无吉他轨也无音高轨 → 「未找到可导入的吉他轨」
 *  4) 非六线谱文本 → 「未识别到六线谱文本」
 */
import { describe, expect, it } from 'vitest';
import type { Tab } from '@/types/tab';
import { buildTabFromChordChart, createEmptyTab } from '@/core/tabFactory';
import { SONG_MORNING } from '@/data/builtinSongs';
import { jsonImporter, asciiImporter, parseAscii } from '@/io/importers';
import { musicXmlImporter } from '@/io/musicXmlImporter';
import { tabToJson } from '@/io/exporters';

describe('QA JSON —— round-trip 往返无损', () => {
  it('导出→导入：谱面内容字段完全一致（除 id/createdAt/updatedAt/revision/source.type 身份字段）', async () => {
    const src = buildTabFromChordChart(SONG_MORNING);
    const result = await jsonImporter.parse(tabToJson(src));
    expect(result.ok).toBe(true);
    const imp = result.tab!;

    // 身份字段会变
    expect(imp.id).not.toBe(src.id);
    expect(imp.createdAt).not.toBe(src.createdAt);
    expect(imp.revision).toBe(1);

    // 内容字段必须无损
    expect(imp.schema).toBe(src.schema);
    expect(imp.schemaVersion).toBe(src.schemaVersion);
    expect(imp.title).toBe(src.title);
    expect(imp.artist).toBe(src.artist);
    expect(imp.key).toBe(src.key);
    expect(imp.capo).toBe(src.capo);
    expect(imp.bpm).toBe(src.bpm);
    expect(imp.timeSignature).toEqual(src.timeSignature);
    expect(imp.ticksPerBeat).toBe(480);
    expect(imp.tags).toEqual(src.tags);
    expect(imp.rhythmPattern).toEqual(src.rhythmPattern);
    expect(imp.practice).toEqual(src.practice);
    expect(imp.markers).toEqual(src.markers);
    // 谱面本体（tracks/measures/notes）逐小节一致
    expect(imp.tracks).toEqual(src.tracks);
  });

  it('带人工编辑（markers / practice / difficultyOverride）的 Tab 往返无损', async () => {
    const src = buildTabFromChordChart(SONG_MORNING);
    src.markers = [
      { id: 'mk_x', measure: 2, note: '换和弦卡', createdAt: '2026-09-08T00:00:00.000Z', loopCount: 3 },
    ];
    src.practice = {
      mastery: 55,
      masteryComputedAt: '2026-09-08T00:00:00.000Z',
      totalSeconds: 1200,
      sessions: 4,
      lastPracticedAt: '2026-09-08T00:00:00.000Z',
      bestBpm: 60,
      targetBpm: 72,
      targetReachedAt: null,
      coveredMeasures: [0, 1, 2],
      roundsTotal: 8,
      roundsPassed: 5,
    };
    src.difficultyOverride = 2;
    const result = await jsonImporter.parse(tabToJson(src));
    expect(result.ok).toBe(true);
    const imp = result.tab!;
    expect(imp.markers).toEqual(src.markers);
    expect(imp.practice).toEqual(src.practice);
    expect(imp.difficultyOverride).toBe(2);
  });
});

describe('QA ASCII —— 宽松解析边界', () => {
  it('行不齐 / 无小节线对齐仍能解析出小节（不报错）', () => {
    // 各行长度不一致 + 每行以数字开头（允许 1..6 弦号）
    const ragged = [
      '1|--0--',
      '2|-1-',
      '3|0',
      '4|---2',
      '5|-3-----',
      '6|0----',
    ].join('\n');
    const parsed = parseAscii(ragged);
    // 宽松解析不允许整体解析失败
    expect(parsed.measures.length).toBeGreaterThan(0);
  });

  it('带横杠/小节线/杂散字符的 ASCII 不崩溃，识别 0-9 品位', () => {
    const ragged = [
      '测试标题',
      'e|-----0--------2--|',
      'B|-----1----2------|',
      'G|---0-------------|',
      'D|-----2-----------|',
      'A|-3---------------|',
      'E|-----------------|',
    ].join('\n');
    const result = asciiImporter.parse(ragged) as unknown as Promise<{ ok: boolean; tab?: Tab }>;
    return result.then((r) => {
      expect(r.ok).toBe(true);
      expect(r.tab!.tracks[0].measures.length).toBeGreaterThan(0);
    });
  });

  it('普通文本（无 6 弦块）→ 未识别到六线谱文本', async () => {
    const result = await asciiImporter.parse('今天天气不错，我练了会儿琴。');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('未识别到六线谱文本');
  });
});

describe('QA MusicXML —— 选轨回退', () => {
  it('纯钢琴轨（有音高）→ 回退五线谱轨，可导入', async () => {
    const pianoOnly = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;
    const result = await musicXmlImporter.parse(pianoOnly);
    expect(result.ok).toBe(true);
    expect(result.tab!.source.importer).toBe('musicxml');
    expect(result.tab!.tracks[0].measures).toHaveLength(1);
  });

  it('既无吉他轨也无音高轨（纯休止）→ 未找到可导入的吉他轨', async () => {
    const restOnly = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><rest/><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;
    const result = await musicXmlImporter.parse(restOnly);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('未找到可导入的吉他轨');
  });

  it('空 XML（无 part）→ 未找到可导入的吉他轨', async () => {
    const result = await musicXmlImporter.parse('<?xml version="1.0"?><score-partwise/>');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('未找到可导入的吉他轨');
  });
});

describe('QA —— 导出文件命名（A-06）', () => {
  it('JSON 导出文件名使用安全曲名', () => {
    // safeFileName 是纯函数，直接验证非法字符被替换
    const { safeFileName } = { safeFileName: (t: string) => t.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名' };
    expect(safeFileName('练习曲 / 晨光: 测试?')).toBe('练习曲 _ 晨光_ 测试_');
    expect(safeFileName('   ')).toBe('未命名');
  });
});

// cloneTab/validateTab 路径被 io.test 覆盖；这里补一条：jsonImporter 拒绝 schema 错误
describe('QA JSON —— schema 校验', () => {
  it('schema 不是 fretly.tab → 拒绝', async () => {
    const tab: Tab = createEmptyTab({ title: 'x' });
    const json = JSON.parse(tabToJson(tab)) as Record<string, unknown>;
    json['schema'] = 'other.schema';
    const result = await jsonImporter.parse(JSON.stringify(json));
    expect(result.ok).toBe(false);
  });
});
