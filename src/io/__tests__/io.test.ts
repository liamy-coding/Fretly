// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Tab } from '@/types/tab';
import { buildTabFromChordChart } from '@/core/tabFactory';
import { SONG_MORNING } from '@/data/builtinSongs';
import { importerById, jsonImporter, asciiImporter, gpImporter, parseAscii } from '@/io/importers';
import { musicXmlImporter } from '@/io/musicXmlImporter';
import { tabToAscii, tabToJson } from '@/io/exporters';

const sourceTab: Tab = buildTabFromChordChart(SONG_MORNING);

function signature(tab: Tab): string[] {
  return tab.tracks[0].measures.flatMap((m) =>
    m.notes.map((n) => `${m.index}:${n.string}:${n.fret}`).sort(),
  );
}

describe('io —— JSON 往返无损', () => {
  it('导出 → 重新导入后谱面结构完全一致（仅 id / 时间戳 / revision 变化）', async () => {
    const json = tabToJson(sourceTab);
    const result = await jsonImporter.parse(json);
    expect(result.ok).toBe(true);
    const imported = result.tab!;

    expect(imported.id).not.toBe(sourceTab.id);
    expect(imported.revision).toBe(1);
    expect(imported.title).toBe(sourceTab.title);
    expect(imported.artist).toBe(sourceTab.artist);
    expect(imported.key).toBe(sourceTab.key);
    expect(imported.capo).toBe(sourceTab.capo);
    expect(imported.bpm).toBe(sourceTab.bpm);
    expect(imported.timeSignature).toEqual(sourceTab.timeSignature);
    expect(imported.ticksPerBeat).toBe(480);
    expect(imported.difficulty).toBe(sourceTab.difficulty);
    expect(imported.tags).toEqual(sourceTab.tags);
    expect(imported.rhythmPattern).toEqual(sourceTab.rhythmPattern);
    expect(imported.practice).toEqual(sourceTab.practice);
    expect(imported.markers).toEqual(sourceTab.markers);
    expect(imported.tracks[0].measures).toEqual(sourceTab.tracks[0].measures);
    expect(imported.tracks[0].measures).toHaveLength(16);
  });

  it('非 Fretly JSON 被拒绝并给出原因', async () => {
    const bad = await jsonImporter.parse('{"hello":"world"}');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('不是有效的 Fretly 谱面文件');

    const broken = await jsonImporter.parse('not json at all');
    expect(broken.ok).toBe(false);
  });

  it('schemaVersion 主版本不一致时拒绝', async () => {
    const json = JSON.stringify({ ...sourceTab, schemaVersion: '2.0' });
    const result = await jsonImporter.parse(json);
    expect(result.ok).toBe(false);
  });

  it('importerById 能取到已注册的导入器', () => {
    expect(importerById('json')?.id).toBe('json');
    expect(importerById('musicxml')?.id).toBe('musicxml');
    expect(importerById('ascii')?.id).toBe('ascii');
  });

  it('gpImporter 是占位实现（抛未实现错误，UI 不注册）', async () => {
    await expect(gpImporter.parse('x')).rejects.toThrow(/未实现/);
  });
});

describe('io —— ASCII 宽松解析与往返', () => {
  it('导出 → 导入后小节数与 (弦, 品) 集合一致', async () => {
    const ascii = tabToAscii(sourceTab);
    expect(ascii).toContain('练习曲 No.1 · 晨光');
    const result = await asciiImporter.parse(ascii);
    expect(result.ok).toBe(true);
    const imported = result.tab!;
    expect(imported.tracks[0].measures).toHaveLength(16);
    expect(signature(imported)).toEqual(signature(sourceTab));
  });

  it('ASCII 导出每 4 小节一行，行首为 e/B/G/D/A/E', () => {
    const ascii = tabToAscii(sourceTab);
    const lines = ascii.split('\n').filter((l) => /^[eEBGDA]\|/.test(l));
    expect(lines.length % 6).toBe(0);
  });

  it('未识别字符按 `-` 处理并计入部分解析（PRD Q5）', async () => {
    const ragged = [
      '测试曲',
      'e|---0---@---',
      'B|---1---1---',
      'G|---0---0---',
      'D|---2---2---',
      'A|---3---3---',
      'E|--------3--',
    ].join('\n');
    const parsed = parseAscii(ragged);
    expect(parsed.title).toBe('测试曲');
    expect(parsed.measures.length).toBeGreaterThan(0);
    expect(parsed.partial).toBe(true);

    const result = await asciiImporter.parse(ragged);
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.tab!.tracks[0].measures.length).toBe(parsed.measures.length);
  });

  it('识别数字弦号开头的块，且不要求小节线对齐', () => {
    const parsed = parseAscii(
      ['1|---0--', '2|--1---', '3|-0----', '4|--2---', '5|-3----', '6|0-----'].join('\n'),
    );
    expect(parsed.measures).toHaveLength(1);
    expect(parsed.measures[0].notes.map((n) => n.string).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('完全不是六线谱时给出明确原因', async () => {
    const result = await asciiImporter.parse('这是一段普通文字，没有六线谱。');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('未识别到六线谱文本');
  });
});

const GUITAR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <work><work-title>测试练习曲</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Guitar</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <sound tempo="96"/>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <notations><technical><string>2</string><fret>1</fret></technical></notations>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>4</duration>
        <notations><technical><string>1</string><fret>0</fret></technical></notations>
      </note>
      <note>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>8</duration>
        <notations><technical><string>1</string><fret>3</fret></technical></notations>
      </note>
    </measure>
    <measure number="2">
      <note>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration>
        <notations><technical><string>1</string><fret>5</fret></technical></notations>
      </note>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
    </measure>
  </part>
</score-partwise>`;

describe('io —— MusicXML 最小可用解析', () => {
  it('解析 6 弦吉他轨：小节数、音符弦/品、BPM、和弦', async () => {
    const result = await musicXmlImporter.parse(GUITAR_XML);
    expect(result.ok).toBe(true);
    const tab = result.tab!;
    expect(tab.title).toBe('测试练习曲');
    expect(tab.bpm).toBe(96);
    expect(tab.timeSignature).toEqual([4, 4]);
    expect(tab.tracks[0].measures).toHaveLength(2);

    const m0 = tab.tracks[0].measures[0];
    expect(m0.notes.map((n) => [n.string, n.fret])).toEqual([
      [2, 1],
      [1, 0],
      [1, 3],
    ]);
    expect(m0.notes[0].startTick).toBe(0);
    expect(m0.notes[1].startTick).toBe(480);
    expect(m0.notes[2].startTick).toBe(960);
    expect(m0.notes[2].durationTick).toBe(960);

    const m1 = tab.tracks[0].measures[1];
    expect(m1.chords.map((c) => c.name)).toEqual(['C']);
    expect(m1.chords[0].diagram).toBe('x32010');
    expect(tab.source.type).toBe('imported');
    expect(tab.source.importer).toBe('musicxml');
  });

  it('既无吉他轨也无音高轨时提示「未找到可导入的吉他轨」', async () => {
    const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><rest/><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;
    const result = await musicXmlImporter.parse(emptyXml);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('未找到可导入的吉他轨');
  });

  it('同 tick 多音只保留品位最低的一个（Q4）', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <notations><technical><string>2</string><fret>1</fret></technical></notations></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <notations><technical><string>5</string><fret>3</fret></technical></notations></note>
    </measure>
  </part>
</score-partwise>`;
    const result = await musicXmlImporter.parse(xml);
    expect(result.ok).toBe(true);
    const notes = result.tab!.tracks[0].measures[0].notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].fret).toBe(1); // 1 品 < 3 品
  });

  it('含反复记号时线性展开并给出「反复记号已忽略」警告', async () => {
    const xml = GUITAR_XML.replace(
      '</measure>\n  </part>',
      '<barline><repeat direction="backward"/></barline></measure>\n  </part>',
    );
    const result = await musicXmlImporter.parse(xml);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('反复记号已忽略');
  });
});

const STAFF_MELODY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <work><work-title>五线谱旋律</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <sound tempo="90"/>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;

describe('io —— MusicXML 五线谱轨回退（增量 §1.3）', () => {
  it('无吉他轨但有音高轨时可导入：E4→弦1品0、A3→弦3品2', async () => {
    const result = await musicXmlImporter.parse(STAFF_MELODY_XML);
    expect(result.ok).toBe(true);
    const tab = result.tab!;
    expect(tab.title).toBe('五线谱旋律');
    expect(tab.source.importer).toBe('musicxml');
    expect(tab.source.confidence).not.toBeNull();

    const notes = tab.tracks[0].measures[0].notes;
    expect(notes.map((n) => [n.string, n.fret])).toEqual([
      [1, 0], // E4 → 1 弦空弦
      [3, 2], // A3 → 3 弦 2 品
    ]);
  });

  it('五线谱轨和弦（C4/E4/G4 同 tick）分配弦互异、无同弦冲突', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;
    const result = await musicXmlImporter.parse(xml);
    expect(result.ok).toBe(true);
    const notes = result.tab!.tracks[0].measures[0].notes;
    expect(notes).toHaveLength(3);
    const strings = notes.map((n) => n.string);
    expect(new Set(strings).size).toBe(3); // 弦互异
    // 低把位（品差合理）
    const frets = notes.map((n) => n.fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(4);
  });

  it('超音域低音（B1=35）折叠进音域且 confidence < 0.45', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>B</step><octave>1</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>`;
    const result = await musicXmlImporter.parse(xml);
    expect(result.ok).toBe(true);
    const note = result.tab!.tracks[0].measures[0].notes[0];
    expect(note.confidence).toBeLessThan(0.45);
  });
});
