"use client";

import { Alert, Button, Card, Divider, Input, InputNumber, Select, Space, Switch, Typography } from "antd";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState, useTransition } from "react";

interface CommandFieldOption {
  readonly label: string;
  readonly value: string;
}

interface CommandField {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "textarea" | "number" | "boolean" | "select";
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly description?: string;
  readonly defaultValue?: string | number | boolean;
  readonly options?: ReadonlyArray<CommandFieldOption>;
}

interface CommandDefinition {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly fields: ReadonlyArray<CommandField>;
}

interface CommandCatalogResponse {
  readonly commands: ReadonlyArray<CommandDefinition>;
  readonly daemon: {
    readonly running: boolean;
    readonly pid: number | null;
  };
}

interface CommandResult {
  readonly ok: boolean;
  readonly parsed?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly raw?: string;
}

const COVERED_COMMANDS = new Set([
  "init",
  "config.set",
  "config.set-global",
  "config.show",
  "config.show-global",
  "doctor",
  "status",
  "book.create",
  "book.update",
  "book.list",
  "draft",
  "write.next",
  "audit",
  "revise",
  "review.list",
  "review.approve",
  "review.approve-all",
  "review.reject",
  "analytics",
  "export",
  "style.analyze",
  "style.import",
  "import.canon",
  "radar.scan",
  "genre.list",
  "genre.show",
  "genre.create",
  "genre.copy",
  "up",
  "down",
]);

function buildInitialValues(fields: ReadonlyArray<CommandField>): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.name, field.defaultValue ?? (field.type === "boolean" ? false : "")]));
}

function renderField(
  field: CommandField,
  value: unknown,
  setValues: Dispatch<SetStateAction<Record<string, unknown>>>,
): React.ReactNode {
  if (field.type === "textarea") {
    return <Input.TextArea rows={4} value={String(value ?? "")} placeholder={field.placeholder} onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))} />;
  }
  if (field.type === "number") {
    return <InputNumber value={typeof value === "number" ? value : undefined} placeholder={field.placeholder} style={{ width: "100%" }} onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next ?? "" }))} />;
  }
  if (field.type === "boolean") {
    return <Switch checked={value === true} onChange={(checked) => setValues((prev) => ({ ...prev, [field.name]: checked }))} />;
  }
  if (field.type === "select") {
    return <Select value={typeof value === "string" ? value : undefined} options={field.options?.slice()} placeholder={field.placeholder} onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))} />;
  }
  return <Input value={String(value ?? "")} placeholder={field.placeholder} onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))} />;
}

export function AdvancedToolsWorkspace() {
  const [catalog, setCatalog] = useState<CommandCatalogResponse | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<string>("");
  const [commandFormValues, setCommandFormValues] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void fetch("/api/inkos/commands", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: CommandCatalogResponse) => setCatalog(data));
  }, []);

  const commands = (catalog?.commands ?? []).filter((command) => !COVERED_COMMANDS.has(command.id));
  const selectedCommand = commands.find((command) => command.id === selectedCommandId) ?? commands[0];

  useEffect(() => {
    if (!selectedCommand) return;
    setSelectedCommandId(selectedCommand.id);
    setCommandFormValues(buildInitialValues(selectedCommand.fields));
  }, [selectedCommand?.id]);

  function runCommand(): void {
    if (!selectedCommand) return;
    setError(null);
    setResult(null);
    startTransition(() => {
      void fetch(`/api/inkos/commands/${selectedCommand.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: commandFormValues }),
      })
        .then(async (response) => {
          const data = (await response.json()) as CommandResult;
          setResult(data);
          if (!response.ok) {
            setError(data.error ?? data.stderr ?? data.raw ?? "命令执行失败");
          }
        })
        .catch((runError: unknown) => {
          setError(runError instanceof Error ? runError.message : String(runError));
        });
    });
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card>
        <Typography.Title level={4}>高级工具</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这里只保留页面还没单独承接的低频能力，避免和首页、设置、书籍工作台重复。
        </Typography.Paragraph>
      </Card>

      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Card title="通用命令执行器">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Select
            value={selectedCommand?.id}
            onChange={(value) => setSelectedCommandId(value)}
            options={commands.map((command) => ({
              label: `${command.category} / ${command.title}`,
              value: command.id,
            }))}
            placeholder="选择命令"
          />
          <Typography.Text type="secondary">{selectedCommand?.description ?? "暂无可用命令。"}</Typography.Text>
          <Divider style={{ margin: "8px 0" }} />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            {(selectedCommand?.fields ?? []).map((field) => (
              <div key={field.name}>
                <Typography.Text strong>{field.label}</Typography.Text>
                <div style={{ marginTop: 6 }}>{renderField(field, commandFormValues[field.name], setCommandFormValues)}</div>
                {field.description ? <Typography.Text type="secondary">{field.description}</Typography.Text> : null}
              </div>
            ))}
          </Space>
          <Space>
            <Button type="primary" loading={isPending} onClick={runCommand} disabled={!selectedCommand}>运行</Button>
            <Button disabled={isPending || !selectedCommand} onClick={() => selectedCommand && setCommandFormValues(buildInitialValues(selectedCommand.fields))}>重置</Button>
          </Space>
          {result ? <pre style={{ margin: 0 }}>{JSON.stringify(result, null, 2)}</pre> : null}
        </Space>
      </Card>
    </Space>
  );
}
