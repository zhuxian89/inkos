export type FieldType = "text" | "textarea" | "number" | "boolean" | "select";

export interface CommandFieldOption {
  readonly label: string;
  readonly value: string;
}

export interface CommandField {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly description?: string;
  readonly defaultValue?: string | number | boolean;
  readonly options?: ReadonlyArray<CommandFieldOption>;
}

export interface CommandDefinition {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly description: string;
  readonly fields: ReadonlyArray<CommandField>;
  readonly supportsJson?: boolean;
  readonly specialHandler?: "daemon-up" | "daemon-down";
  buildArgs(values: Record<string, unknown>): string[];
}

function addIfValue(args: string[], flag: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  args.push(flag, String(value));
}

function addIfTrue(args: string[], flag: string, value: unknown): void {
  if (value === true) args.push(flag);
}

export const commandRegistry: ReadonlyArray<CommandDefinition> = [
  {
    id: "init",
    category: "Project",
    title: "Initialize Project",
    description: "Create an InkOS project in the current directory or a subdirectory.",
    fields: [
      { name: "name", label: "Project Name", type: "text", placeholder: "Leave blank to init current directory" },
    ],
    buildArgs(values) {
      const args = ["init"];
      if (values.name) args.push(String(values.name));
      return args;
    },
  },
  {
    id: "config.set",
    category: "Project",
    title: "Set Project Config",
    description: "Write a value into the current project's inkos.json.",
    fields: [
      { name: "key", label: "Config Key", type: "text", required: true, placeholder: "llm.model" },
      { name: "value", label: "Value", type: "text", required: true, placeholder: "gpt-4o" },
    ],
    buildArgs(values) {
      return ["config", "set", String(values.key), String(values.value)];
    },
  },
  {
    id: "config.set-global",
    category: "Project",
    title: "Set Global LLM Config",
    description: "Write shared LLM credentials into ~/.inkos/.env for this runtime environment.",
    fields: [
      { name: "provider", label: "Provider", type: "select", required: true, defaultValue: "openai", options: [{ label: "OpenAI / compatible", value: "openai" }, { label: "Anthropic", value: "anthropic" }] },
      { name: "baseUrl", label: "Base URL", type: "text", required: true, defaultValue: "https://api.openai.com/v1" },
      { name: "apiKey", label: "API Key", type: "text", required: true },
      { name: "model", label: "Model", type: "text", required: true, defaultValue: "gpt-4o" },
      { name: "temperature", label: "Temperature", type: "number", placeholder: "0.7" },
      { name: "maxTokens", label: "Max Tokens", type: "number", placeholder: "16000" },
      { name: "thinkingBudget", label: "Thinking Budget", type: "number" },
      { name: "apiFormat", label: "API Format", type: "select", options: [{ label: "chat", value: "chat" }, { label: "responses", value: "responses" }] },
    ],
    buildArgs(values) {
      const args = ["config", "set-global"];
      addIfValue(args, "--provider", values.provider);
      addIfValue(args, "--base-url", values.baseUrl);
      addIfValue(args, "--api-key", values.apiKey);
      addIfValue(args, "--model", values.model);
      addIfValue(args, "--temperature", values.temperature);
      addIfValue(args, "--max-tokens", values.maxTokens);
      addIfValue(args, "--thinking-budget", values.thinkingBudget);
      addIfValue(args, "--api-format", values.apiFormat);
      return args;
    },
  },
  {
    id: "config.show",
    category: "Project",
    title: "Show Project Config",
    description: "Read the current project's inkos.json.",
    fields: [],
    buildArgs() {
      return ["config", "show"];
    },
  },
  {
    id: "config.show-global",
    category: "Project",
    title: "Show Global Config",
    description: "Read ~/.inkos/.env with the API key masked.",
    fields: [],
    buildArgs() {
      return ["config", "show-global"];
    },
  },
  {
    id: "doctor",
    category: "Project",
    title: "Doctor",
    description: "Run environment and connectivity checks.",
    fields: [],
    buildArgs() {
      return ["doctor"];
    },
  },
  {
    id: "status",
    category: "Project",
    title: "Project Status",
    description: "Show the status of one book or the whole project.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text", placeholder: "Leave blank for all books" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["status"];
      if (values.bookId) args.push(String(values.bookId));
      return args;
    },
  },
  {
    id: "book.create",
    category: "Books",
    title: "Create Book",
    description: "Create a book and generate the foundation with AI.",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "genre", label: "Genre", type: "text", defaultValue: "xuanhuan" },
      { name: "platform", label: "Platform", type: "text", defaultValue: "tomato" },
      { name: "targetChapters", label: "Target Chapters", type: "number", defaultValue: 200 },
      { name: "chapterWords", label: "Words Per Chapter", type: "number", defaultValue: 3000 },
      { name: "context", label: "Context", type: "textarea", placeholder: "Optional natural-language direction" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["book", "create", "--title", String(values.title)];
      addIfValue(args, "--genre", values.genre);
      addIfValue(args, "--platform", values.platform);
      addIfValue(args, "--target-chapters", values.targetChapters);
      addIfValue(args, "--chapter-words", values.chapterWords);
      addIfValue(args, "--context", values.context);
      return args;
    },
  },
  {
    id: "book.update",
    category: "Books",
    title: "Update Book",
    description: "Update chapter count, chapter word count or book status.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text", placeholder: "Leave blank for auto-detect" },
      { name: "chapterWords", label: "Words Per Chapter", type: "number" },
      { name: "targetChapters", label: "Target Chapters", type: "number" },
      { name: "status", label: "Status", type: "select", options: [{ label: "outlining", value: "outlining" }, { label: "active", value: "active" }, { label: "paused", value: "paused" }, { label: "completed", value: "completed" }] },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["book", "update"];
      if (values.bookId) args.push(String(values.bookId));
      addIfValue(args, "--chapter-words", values.chapterWords);
      addIfValue(args, "--target-chapters", values.targetChapters);
      addIfValue(args, "--status", values.status);
      return args;
    },
  },
  {
    id: "book.list",
    category: "Books",
    title: "List Books",
    description: "List all books in the project.",
    fields: [],
    supportsJson: true,
    buildArgs() {
      return ["book", "list"];
    },
  },
  {
    id: "draft",
    category: "Writing",
    title: "Write Draft",
    description: "Write a draft chapter without audit and revise.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "words", label: "Override Word Count", type: "number" },
      { name: "context", label: "Creative Guidance", type: "textarea" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["draft"];
      if (values.bookId) args.push(String(values.bookId));
      addIfValue(args, "--words", values.words);
      addIfValue(args, "--context", values.context);
      return args;
    },
  },
  {
    id: "write.next",
    category: "Writing",
    title: "Write Next Chapter",
    description: "Write one or more chapters with audit and optional auto-revise.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "count", label: "Chapter Count", type: "number", defaultValue: 1 },
      { name: "words", label: "Override Word Count", type: "number" },
      { name: "context", label: "Creative Guidance", type: "textarea" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["write", "next"];
      if (values.bookId) args.push(String(values.bookId));
      addIfValue(args, "--count", values.count);
      addIfValue(args, "--words", values.words);
      addIfValue(args, "--context", values.context);
      return args;
    },
  },
  {
    id: "write.rewrite",
    category: "Writing",
    title: "Rewrite Chapter",
    description: "Delete a chapter and later chapters, restore state, then regenerate.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "chapter", label: "Chapter Number", type: "number", required: true },
      { name: "words", label: "Override Word Count", type: "number" },
      { name: "force", label: "Skip Confirmation", type: "boolean", defaultValue: true },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["write", "rewrite"];
      if (values.bookId) args.push(String(values.bookId));
      args.push(String(values.chapter));
      addIfTrue(args, "--force", values.force ?? true);
      addIfValue(args, "--words", values.words);
      return args;
    },
  },
  {
    id: "audit",
    category: "Writing",
    title: "Audit Chapter",
    description: "Run continuity and rules audit on a chapter.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "chapter", label: "Chapter Number", type: "number", placeholder: "Leave blank for latest" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["audit"];
      if (values.bookId) args.push(String(values.bookId));
      if (values.chapter) args.push(String(values.chapter));
      return args;
    },
  },
  {
    id: "revise",
    category: "Writing",
    title: "Revise Chapter",
    description: "Revise a chapter based on audit issues.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "chapter", label: "Chapter Number", type: "number" },
      { name: "mode", label: "Revise Mode", type: "select", defaultValue: "rewrite", options: [{ label: "rewrite", value: "rewrite" }, { label: "spot-fix", value: "spot-fix" }, { label: "polish", value: "polish" }, { label: "rework", value: "rework" }] },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["revise"];
      if (values.bookId) args.push(String(values.bookId));
      if (values.chapter) args.push(String(values.chapter));
      addIfValue(args, "--mode", values.mode);
      return args;
    },
  },
  {
    id: "review.list",
    category: "Review",
    title: "List Pending Reviews",
    description: "List chapters waiting for manual review.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["review", "list"];
      if (values.bookId) args.push(String(values.bookId));
      return args;
    },
  },
  {
    id: "review.approve",
    category: "Review",
    title: "Approve Chapter",
    description: "Approve one reviewed chapter.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "chapter", label: "Chapter Number", type: "number", required: true },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["review", "approve"];
      if (values.bookId) args.push(String(values.bookId));
      args.push(String(values.chapter));
      return args;
    },
  },
  {
    id: "review.approve-all",
    category: "Review",
    title: "Approve All",
    description: "Approve all pending chapters for a book.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["review", "approve-all"];
      if (values.bookId) args.push(String(values.bookId));
      return args;
    },
  },
  {
    id: "review.reject",
    category: "Review",
    title: "Reject Chapter",
    description: "Reject one chapter and optionally store a reason.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "chapter", label: "Chapter Number", type: "number", required: true },
      { name: "reason", label: "Reason", type: "textarea" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["review", "reject"];
      if (values.bookId) args.push(String(values.bookId));
      args.push(String(values.chapter));
      addIfValue(args, "--reason", values.reason);
      return args;
    },
  },
  {
    id: "analytics",
    category: "Review",
    title: "Book Analytics",
    description: "Summarize chapters, issue distribution and pass rate.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["analytics"];
      if (values.bookId) args.push(String(values.bookId));
      return args;
    },
  },
  {
    id: "detect",
    category: "Detection",
    title: "Detect AIGC",
    description: "Run AIGC detection for one chapter or all chapters.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "chapter", label: "Chapter Number", type: "number" },
      { name: "all", label: "All Chapters", type: "boolean" },
      { name: "stats", label: "Show Stats", type: "boolean" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["detect"];
      if (values.bookId) args.push(String(values.bookId));
      if (values.chapter) args.push(String(values.chapter));
      addIfTrue(args, "--all", values.all);
      addIfTrue(args, "--stats", values.stats);
      return args;
    },
  },
  {
    id: "style.analyze",
    category: "Style",
    title: "Analyze Style File",
    description: "Analyze a text file and extract a style profile.",
    fields: [
      { name: "file", label: "File Path", type: "text", required: true, placeholder: "/workspace/reference.txt" },
      { name: "name", label: "Source Name", type: "text" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["style", "analyze", String(values.file)];
      addIfValue(args, "--name", values.name);
      return args;
    },
  },
  {
    id: "style.import",
    category: "Style",
    title: "Import Style",
    description: "Import a style profile into a book and optionally generate a style guide.",
    fields: [
      { name: "file", label: "File Path", type: "text", required: true, placeholder: "/workspace/reference.txt" },
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "name", label: "Source Name", type: "text" },
      { name: "statsOnly", label: "Stats Only", type: "boolean" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["style", "import", String(values.file)];
      if (values.bookId) args.push(String(values.bookId));
      addIfValue(args, "--name", values.name);
      addIfTrue(args, "--stats-only", values.statsOnly);
      return args;
    },
  },
  {
    id: "import.canon",
    category: "Style",
    title: "Import Canon",
    description: "Import canon from a parent book into a target book.",
    fields: [
      { name: "bookId", label: "Target Book ID", type: "text" },
      { name: "from", label: "Parent Book ID", type: "text", required: true },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["import", "canon"];
      if (values.bookId) args.push(String(values.bookId));
      addIfValue(args, "--from", values.from);
      return args;
    },
  },
  {
    id: "radar.scan",
    category: "Market",
    title: "Scan Radar",
    description: "Run the market intelligence scan and save the result.",
    fields: [],
    supportsJson: true,
    buildArgs() {
      return ["radar", "scan"];
    },
  },
  {
    id: "export",
    category: "Export",
    title: "Export Book",
    description: "Export chapters into a single file.",
    fields: [
      { name: "bookId", label: "Book ID", type: "text" },
      { name: "format", label: "Format", type: "select", defaultValue: "txt", options: [{ label: "txt", value: "txt" }, { label: "md", value: "md" }] },
      { name: "output", label: "Output Path", type: "text", placeholder: "Optional custom path" },
      { name: "approvedOnly", label: "Approved Only", type: "boolean" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["export"];
      if (values.bookId) args.push(String(values.bookId));
      addIfValue(args, "--format", values.format);
      addIfValue(args, "--output", values.output);
      addIfTrue(args, "--approved-only", values.approvedOnly);
      return args;
    },
  },
  {
    id: "genre.list",
    category: "Genres",
    title: "List Genres",
    description: "List built-in and project-level genres.",
    fields: [],
    buildArgs() {
      return ["genre", "list"];
    },
  },
  {
    id: "genre.show",
    category: "Genres",
    title: "Show Genre",
    description: "Display one genre profile.",
    fields: [
      { name: "id", label: "Genre ID", type: "text", required: true, placeholder: "xuanhuan" },
    ],
    buildArgs(values) {
      return ["genre", "show", String(values.id)];
    },
  },
  {
    id: "genre.create",
    category: "Genres",
    title: "Create Genre",
    description: "Scaffold a project-specific genre profile.",
    fields: [
      { name: "id", label: "Genre ID", type: "text", required: true },
      { name: "name", label: "Display Name", type: "text" },
      { name: "numerical", label: "Enable Numerical System", type: "boolean" },
      { name: "power", label: "Enable Power Scaling", type: "boolean" },
      { name: "era", label: "Enable Era Research", type: "boolean" },
    ],
    buildArgs(values) {
      const args = ["genre", "create", String(values.id)];
      addIfValue(args, "--name", values.name);
      addIfTrue(args, "--numerical", values.numerical);
      addIfTrue(args, "--power", values.power);
      addIfTrue(args, "--era", values.era);
      return args;
    },
  },
  {
    id: "genre.copy",
    category: "Genres",
    title: "Copy Genre",
    description: "Copy a built-in genre into the project for customization.",
    fields: [
      { name: "id", label: "Genre ID", type: "text", required: true, placeholder: "xuanhuan" },
    ],
    buildArgs(values) {
      return ["genre", "copy", String(values.id)];
    },
  },
  {
    id: "agent",
    category: "Advanced",
    title: "Agent Mode",
    description: "Use the natural-language orchestration mode.",
    fields: [
      { name: "instruction", label: "Instruction", type: "textarea", required: true },
      { name: "context", label: "Extra Context", type: "textarea" },
      { name: "maxTurns", label: "Max Turns", type: "number", defaultValue: 20 },
      { name: "quiet", label: "Quiet", type: "boolean" },
    ],
    supportsJson: true,
    buildArgs(values) {
      const args = ["agent", String(values.instruction)];
      addIfValue(args, "--context", values.context);
      addIfValue(args, "--max-turns", values.maxTurns);
      addIfTrue(args, "--quiet", values.quiet);
      return args;
    },
  },
  {
    id: "up",
    category: "Daemon",
    title: "Start Daemon",
    description: "Start the background scheduler in a detached process.",
    fields: [],
    specialHandler: "daemon-up",
    buildArgs() {
      return ["up"];
    },
  },
  {
    id: "down",
    category: "Daemon",
    title: "Stop Daemon",
    description: "Stop the background scheduler.",
    fields: [],
    specialHandler: "daemon-down",
    buildArgs() {
      return ["down"];
    },
  },
  {
    id: "update",
    category: "Advanced",
    title: "Update CLI",
    description: "Run the legacy self-update command. In Docker, image rebuilds are preferred.",
    fields: [],
    buildArgs() {
      return ["update"];
    },
  },
];

export function getCommandDefinition(commandId: string): CommandDefinition | undefined {
  return commandRegistry.find((command) => command.id === commandId);
}
