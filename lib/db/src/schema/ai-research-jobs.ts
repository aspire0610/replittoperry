import { date, index, pgTable, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { aiResearchEmployeesTable } from "./ai-research-employees";

export type AiResearchJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type AiResearchAgentTask = {
  id: string;
  name: string;
  specialty: string;
  task: string;
  status: AiResearchJobStatus;
  analysis: string;
  sources: Array<{ title: string; url: string }>;
};

export const aiResearchJobsTable = pgTable(
  "ai_research_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    lineUserId: text("line_user_id"),
    employeeId: text("employee_id").references(() => aiResearchEmployeesTable.id, { onDelete: "cascade" }),
    scheduledDate: date("scheduled_date", { mode: "string" }),
    channel: text("channel").notNull().default("web"),
    question: text("question").notNull(),
    status: text("status").$type<AiResearchJobStatus>().notNull().default("queued"),
    answer: text("answer"),
    agents: jsonb("agents").$type<AiResearchAgentTask[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_research_jobs_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("ai_research_jobs_employee_date_uidx").on(table.employeeId, table.scheduledDate),
  ],
);
