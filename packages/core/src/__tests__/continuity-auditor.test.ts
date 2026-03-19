import { describe, expect, it } from "vitest";
import { ContinuityAuditor } from "../agents/continuity.js";

type AuditResult = {
  passed: boolean;
  issues: Array<{
    severity: "critical" | "warning" | "info";
    category: string;
    description: string;
    suggestion: string;
  }>;
  summary: string;
};

function callParseAuditResult(content: string): AuditResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = ContinuityAuditor.prototype as any;
  return proto.parseAuditResult.call(null, content);
}

function callParseResearchResult(content: string): {
  findings: string[];
  sources: string[];
  openQuestions: string[];
  error?: string;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = ContinuityAuditor.prototype as any;
  return proto.parseResearchResult.call(null, content);
}

describe("ContinuityAuditor parseAuditResult", () => {
  it("extracts the trailing audit JSON after tool-call traces", () => {
    const result = callParseAuditResult([
      "Searching for historical/geographic references...",
      "search_web({\"query\":\"肃州 历史 盐碱地\", \"max_results\": 5})",
      "search_web query: 肃州 历史 盐碱地",
      JSON.stringify({
        passed: true,
        issues: [
          {
            severity: "warning",
            category: "设定冲突",
            description: "订单规模冲突",
            suggestion: "统一圣经数据",
          },
        ],
        summary: "发现 1 个问题",
      }),
    ].join(""));

    expect(result).toEqual({
      passed: true,
      issues: [
        {
          severity: "warning",
          category: "设定冲突",
          description: "订单规模冲突",
          suggestion: "统一圣经数据",
        },
      ],
      summary: "发现 1 个问题",
    });
  });

  it("returns a system error when no audit JSON object is present", () => {
    const result = callParseAuditResult("search_web({\"query\":\"肃州\"})");

    expect(result.passed).toBe(false);
    expect(result.summary).toBe("审稿 JSON 解析失败");
    expect(result.issues[0]?.category).toBe("系统错误");
  });

  it("extracts structured research JSON after search traces", () => {
    const result = callParseResearchResult([
      "Searching for historical references...",
      "search_web({\"query\":\"肃州 历史 地理\"})",
      JSON.stringify({
        findings: ["肃州即今酒泉一带，地理表述基本合理"],
        sources: ["地方志与地理词条交叉一致"],
        openQuestions: ["三代不得返籍需进一步核验具体朝代法制"],
      }),
    ].join(""));

    expect(result).toEqual({
      findings: ["肃州即今酒泉一带，地理表述基本合理"],
      sources: ["地方志与地理词条交叉一致"],
      openQuestions: ["三代不得返籍需进一步核验具体朝代法制"],
    });
  });

  it("returns research-stage error when research JSON is missing", () => {
    const result = callParseResearchResult("search_web({\"query\":\"秋审 制度\"})");

    expect(result.findings).toEqual([]);
    expect(result.error).toBe("研究阶段输出异常");
  });

  it("returns final-stage specific error when final audit json is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = ContinuityAuditor.prototype as any;
    const result = proto.parseAuditResult.call(null, "search_web({\"query\":\"肃州\"})", "final");

    expect(result.passed).toBe(false);
    expect(result.summary).toBe("最终审稿输出异常");
    expect(result.issues[0]?.description).toBe("最终审稿 JSON 结构非法");
  });
});
