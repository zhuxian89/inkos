import { describe, expect, it } from "vitest";
import {
  buildHonestChapterFallback,
  finalizeAssistantReply,
  hasSuccessfulWrite,
  parseToolResultOk,
} from "../context/write-integrity.js";

describe("parseToolResultOk", () => {
  it("returns true only for ok:true JSON", () => {
    expect(parseToolResultOk(JSON.stringify({ ok: true, path: "/a" }))).toBe(true);
    expect(parseToolResultOk(JSON.stringify({ ok: false, error: "x" }))).toBe(false);
    expect(parseToolResultOk("not json")).toBe(false);
    expect(parseToolResultOk("{broken")).toBe(false);
  });
});

describe("finalizeAssistantReply", () => {
  it("N1: claims modification without successful write → warning", () => {
    const reply = finalizeAssistantReply({
      reply: "我已经修改了第三章开头。",
      toolTrace: [{ name: "write_text_file", args: { path: "/a" }, ok: false, error: "fail" }],
      reachedMaxTurns: false,
    });
    expect(reply).toContain("未成功写入");
    expect(reply).not.toContain("工具执行记录");
  });

  it("N2: successful write → execution record", () => {
    const reply = finalizeAssistantReply({
      reply: "改好了。",
      toolTrace: [{ name: "write_text_file", args: { path: "/chapters/3.md" }, ok: true }],
      reachedMaxTurns: false,
    });
    expect(reply).toContain("工具执行记录");
    expect(reply).toContain("/chapters/3.md");
  });

  it("does not warn when claim matches successful write", () => {
    const reply = finalizeAssistantReply({
      reply: "已修改文件。",
      toolTrace: [{ name: "write_text_file", args: { path: "/a" }, ok: true }],
      reachedMaxTurns: false,
    });
    expect(reply).not.toContain("未成功写入");
  });
});

describe("buildHonestChapterFallback", () => {
  it("N3: failed write only → no fake completion", () => {
    const text = buildHonestChapterFallback([
      { name: "write_text_file", args: { path: "/a" }, ok: false },
    ]);
    expect(text).not.toContain("已完成修改");
    expect(text).not.toContain("写回相关文件");
    expect(text).toContain("未成功");
  });

  it("successful write → completion copy", () => {
    const text = buildHonestChapterFallback([
      { name: "write_text_file", args: { path: "/a" }, ok: true },
    ]);
    expect(text).toContain("写回相关文件");
  });
});

describe("hasSuccessfulWrite", () => {
  it("B1: non-write ok true does not count", () => {
    expect(hasSuccessfulWrite([{ name: "read_text_file", args: {}, ok: true }])).toBe(false);
  });
});
