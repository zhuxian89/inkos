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
});
