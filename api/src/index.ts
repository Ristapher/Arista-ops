// C:\Users\forgo\arista-ops\api\src\index.ts
export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN?: string;
  OWNER_EMAIL?: string;
  API_AUTH_TOKEN?: string;
  EMAIL_SERVICE_URL?: string;
  EMAIL_SERVICE_API_KEY?: string;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type Customer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  tag: string;
  notes: string;
  createdAt: string;
};

type Job = {
  id: string;
  customerId: string;
  customerName: string;
  scheduledDate: string;
  scheduledTime: string;
  issue: string;
  status: string;
  notes: string;
  amount: number;
  photos: number;
  createdAt: string;
  jobNumber: string;
};

type Estimate = {
  id: string;
  customerId: string;
  customerName: string;
  total: number;
  status: string;
  notes: string;
  createdAt: string;
};

type Invoice = {
  id: string;
  customerId: string;
  customerName: string;
  total: number;
  status: string;
  notes: string;
  paymentLink: string;
  createdAt: string;
  jobNumber: string;
};

type FollowUp = {
  id: string;
  customerId: string;
  customerName: string;
  dueDate: string;
  method: string;
  notes: string;
  done: boolean;
  createdAt: string;
};

type StatePayload = {
  owner: string;
  stateVersion: number;
  customers: Customer[];
  jobs: Job[];
  estimates: Estimate[];
  invoices: Invoice[];
  followups: FollowUp[];
};

type OwnerMeta = {
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  stateVersion: number;
};

type ApiState = {
  owner: string;
  stateVersion: number;
  lastSavedAt: string;
  customers: Customer[];
  jobs: Job[];
  estimates: Estimate[];
  invoices: Invoice[];
  followups: FollowUp[];
};

type EmailProxyPayload = {
  toEmail: string;
  customerName: string;
  amount: number;
  status: string;
  jobNumber: string;
  notes: string;
  paymentUrl: string;
};

const CUSTOMER_TAGS = new Set(["Lead", "Customer", "VIP", "Past Due", "Inactive", ""]);
const JOB_STATUSES = new Set(["Open", "Scheduled", "In Progress", "Completed", "Canceled", ""]);
const ESTIMATE_STATUSES = new Set(["Draft", "Sent", "Approved", "Rejected", "Expired", ""]);
const INVOICE_STATUSES = new Set(["Unpaid", "Paid", "Overdue", "Void", ""]);
const FOLLOWUP_METHODS = new Set(["Call", "Text", "Email", "Visit", ""]);
const EMAIL_STATUSES = new Set(["Unpaid", "Paid", "Overdue", "Void"]);
const MAX_TEXT = 5000;
const MAX_NOTES = 20000;

class ValidationError extends Error {
  public readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return withCors(env, new Response(null, { status: 204 }), request);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return withCors(
          env,
          jsonResponse({
            ok: true,
            service: "arista-ops-api",
            authRequired: Boolean((env.API_AUTH_TOKEN ?? "").trim()),
            emailProxyConfigured: Boolean((env.EMAIL_SERVICE_URL ?? "").trim() && (env.EMAIL_SERVICE_API_KEY ?? "").trim()),
          }),
          request,
        );
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        requireApiTokenIfConfigured(request, env);
        const owner = resolveOwnerFromRequest(request, env, url.searchParams.get("owner"));
        const state = await readState(env.DB, owner);
        return withCors(env, jsonResponse(state), request);
      }

      if (request.method === "POST" && url.pathname === "/api/state") {
        requireApiTokenIfConfigured(request, env);
        const rawBody = (await request.json()) as unknown;
        const payload = validateStatePayload(rawBody, request, env);
        const result = await writeState(env.DB, payload);
        return withCors(env, jsonResponse(result), request);
      }

      if (request.method === "POST" && url.pathname === "/api/send-invoice-email") {
        requireApiTokenIfConfigured(request, env);
        const rawBody = (await request.json()) as unknown;
        const payload = validateEmailProxyPayload(rawBody);
        const result = await proxyInvoiceEmail(payload, env);
        return withCors(env, jsonResponse(result.body, result.status), request);
      }

      return withCors(
        env,
        jsonResponse(
          {
            ok: false,
            error: "Not found",
          },
          404,
        ),
        request,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = error instanceof ValidationError ? error.status : 500;

      return withCors(
        env,
        jsonResponse(
          {
            ok: false,
            error: message,
          },
          status,
        ),
        request,
      );
    }
  },
};

function jsonResponse(data: JsonValue | Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function withCors(env: Env, response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigins = parseAllowedOrigins(env);

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    headers.set("access-control-allow-origin", requestOrigin);
    headers.set("vary", "Origin");
  } else if (allowedOrigins.length === 0) {
    headers.set("access-control-allow-origin", "*");
  }

  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,x-owner-email,x-api-token");
  headers.set("access-control-max-age", "86400");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requireApiTokenIfConfigured(request: Request, env: Env): void {
  const expected = (env.API_AUTH_TOKEN ?? "").trim();
  if (!expected) {
    return;
  }

  const provided = (request.headers.get("x-api-token") ?? "").trim();
  if (!provided) {
    throw new ValidationError("Missing x-api-token header.", 401);
  }

  if (!timingSafeEqual(provided, expected)) {
    throw new ValidationError("Invalid API token.", 401);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

function resolveOwnerFromRequest(request: Request, env: Env, explicitOwner?: string | null): string {
  const configuredOwner = normalizeOwnerEmail(env.OWNER_EMAIL ?? "");

  if (configuredOwner) {
    return configuredOwner;
  }

  const owner =
    explicitOwner ??
    request.headers.get("x-owner-email") ??
    "";

  const normalized = normalizeOwnerEmail(owner);
  if (!normalized) {
    throw new ValidationError("Owner email is required.");
  }

  return normalized;
}

function normalizeOwnerEmail(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
}

function normalizeString(value: unknown, field: string, maxLength = MAX_TEXT): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ValidationError(`${field} is too long.`);
  }

  return normalized;
}

function normalizeOptionalString(value: unknown, field: string, maxLength = MAX_TEXT): string {
  if (value == null || value === "") {
    return "";
  }

  return normalizeString(value, field, maxLength);
}

function requireNonEmptyString(value: unknown, field: string, maxLength = MAX_TEXT): string {
  const normalized = normalizeString(value, field, maxLength);
  if (!normalized) {
    throw new ValidationError(`${field} is required.`);
  }
  return normalized;
}

function normalizeIsoishString(value: unknown, field: string): string {
  return normalizeOptionalString(value, field, 100);
}

function normalizeEmail(value: unknown, field: string, required: boolean): string {
  const normalized = required ? requireNonEmptyString(value, field, 320) : normalizeOptionalString(value, field, 320);

  if (!normalized) {
    return "";
  }

  const email = normalized.toLowerCase();
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!looksLikeEmail) {
    throw new ValidationError(`${field} must be a valid email address.`);
  }

  return email;
}

function normalizeEnum(value: unknown, field: string, allowed: Set<string>, required: boolean): string {
  const normalized = required ? requireNonEmptyString(value, field, 100) : normalizeOptionalString(value, field, 100);

  if (!allowed.has(normalized)) {
    throw new ValidationError(`${field} has an invalid value.`);
  }

  return normalized;
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function normalizeInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new ValidationError(`${field} is out of range.`);
  }
  return value;
}

function normalizeMoneyNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000_000) {
    throw new ValidationError(`${field} must be a valid amount.`);
  }
  return Number(value.toFixed(2));
}

function normalizeStateVersion(value: unknown): number {
  if (value == null) {
    return 0;
  }
  return normalizeInteger(value, "stateVersion", 0, 2_147_483_647);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array.`);
  }
  return value;
}

function validateId(value: unknown, field: string): string {
  const id = requireNonEmptyString(value, field, 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new ValidationError(`${field} contains invalid characters.`);
  }
  return id;
}

function validateCustomer(input: unknown, index: number): Customer {
  const row = asRecord(input, `customers[${index}]`);

  return {
    id: validateId(row.id, `customers[${index}].id`),
    name: requireNonEmptyString(row.name, `customers[${index}].name`, 200),
    phone: normalizeOptionalString(row.phone, `customers[${index}].phone`, 50),
    email: normalizeEmail(row.email, `customers[${index}].email`, false),
    address: normalizeOptionalString(row.address, `customers[${index}].address`, 500),
    tag: normalizeEnum(row.tag ?? "", `customers[${index}].tag`, CUSTOMER_TAGS, false),
    notes: normalizeOptionalString(row.notes, `customers[${index}].notes`, MAX_NOTES),
    createdAt: normalizeIsoishString(row.createdAt, `customers[${index}].createdAt`),
  };
}

function validateJob(input: unknown, index: number): Job {
  const row = asRecord(input, `jobs[${index}]`);

  return {
    id: validateId(row.id, `jobs[${index}].id`),
    customerId: validateId(row.customerId, `jobs[${index}].customerId`),
    customerName: requireNonEmptyString(row.customerName, `jobs[${index}].customerName`, 200),
    scheduledDate: normalizeOptionalString(row.scheduledDate, `jobs[${index}].scheduledDate`, 50),
    scheduledTime: normalizeOptionalString(row.scheduledTime, `jobs[${index}].scheduledTime`, 50),
    issue: requireNonEmptyString(row.issue, `jobs[${index}].issue`, 2000),
    status: normalizeEnum(row.status ?? "", `jobs[${index}].status`, JOB_STATUSES, true),
    notes: normalizeOptionalString(row.notes, `jobs[${index}].notes`, MAX_NOTES),
    amount: normalizeInteger(row.amount ?? 0, `jobs[${index}].amount`, 0, 100_000_000_00),
    photos: normalizeInteger(row.photos ?? 0, `jobs[${index}].photos`, 0, 10_000),
    createdAt: normalizeIsoishString(row.createdAt, `jobs[${index}].createdAt`),
    jobNumber: normalizeOptionalString(row.jobNumber, `jobs[${index}].jobNumber`, 100),
  };
}

function validateEstimate(input: unknown, index: number): Estimate {
  const row = asRecord(input, `estimates[${index}]`);

  return {
    id: validateId(row.id, `estimates[${index}].id`),
    customerId: validateId(row.customerId, `estimates[${index}].customerId`),
    customerName: requireNonEmptyString(row.customerName, `estimates[${index}].customerName`, 200),
    total: normalizeInteger(row.total ?? 0, `estimates[${index}].total`, 0, 100_000_000_00),
    status: normalizeEnum(row.status ?? "", `estimates[${index}].status`, ESTIMATE_STATUSES, false),
    notes: normalizeOptionalString(row.notes, `estimates[${index}].notes`, MAX_NOTES),
    createdAt: normalizeIsoishString(row.createdAt, `estimates[${index}].createdAt`),
  };
}

function validateInvoice(input: unknown, index: number): Invoice {
  const row = asRecord(input, `invoices[${index}]`);

  return {
    id: validateId(row.id, `invoices[${index}].id`),
    customerId: validateId(row.customerId, `invoices[${index}].customerId`),
    customerName: requireNonEmptyString(row.customerName, `invoices[${index}].customerName`, 200),
    total: normalizeInteger(row.total ?? 0, `invoices[${index}].total`, 0, 100_000_000_00),
    status: normalizeEnum(row.status ?? "", `invoices[${index}].status`, INVOICE_STATUSES, true),
    notes: normalizeOptionalString(row.notes, `invoices[${index}].notes`, MAX_NOTES),
    paymentLink: normalizeOptionalString(row.paymentLink, `invoices[${index}].paymentLink`, 2000),
    createdAt: normalizeIsoishString(row.createdAt, `invoices[${index}].createdAt`),
    jobNumber: normalizeOptionalString(row.jobNumber, `invoices[${index}].jobNumber`, 100),
  };
}

function validateFollowUp(input: unknown, index: number): FollowUp {
  const row = asRecord(input, `followups[${index}]`);

  return {
    id: validateId(row.id, `followups[${index}].id`),
    customerId: validateId(row.customerId, `followups[${index}].customerId`),
    customerName: requireNonEmptyString(row.customerName, `followups[${index}].customerName`, 200),
    dueDate: normalizeOptionalString(row.dueDate, `followups[${index}].dueDate`, 50),
    method: normalizeEnum(row.method ?? "", `followups[${index}].method`, FOLLOWUP_METHODS, false),
    notes: normalizeOptionalString(row.notes, `followups[${index}].notes`, MAX_NOTES),
    done: normalizeBoolean(row.done ?? false, `followups[${index}].done`),
    createdAt: normalizeIsoishString(row.createdAt, `followups[${index}].createdAt`),
  };
}

function validateEmailProxyPayload(rawBody: unknown): EmailProxyPayload {
  const body = asRecord(rawBody, "request body");

  return {
    toEmail: normalizeEmail(body.toEmail, "toEmail", true),
    customerName: normalizeOptionalString(body.customerName, "customerName", 200),
    amount: normalizeMoneyNumber(body.amount, "amount"),
    status: normalizeEnum(body.status, "status", EMAIL_STATUSES, true),
    jobNumber: normalizeOptionalString(body.jobNumber, "jobNumber", 100),
    notes: normalizeOptionalString(body.notes, "notes", MAX_NOTES),
    paymentUrl: normalizeOptionalString(body.paymentUrl, "paymentUrl", 2000),
  };
}

function ensureUniqueIds<T extends { id: string }>(rows: T[], field: string): void {
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new ValidationError(`${field} contains duplicate id: ${row.id}`);
    }
    seen.add(row.id);
  }
}

function validateRelationships(payload: StatePayload): void {
  const customerIds = new Set(payload.customers.map((row) => row.id));

  for (const job of payload.jobs) {
    if (!customerIds.has(job.customerId)) {
      throw new ValidationError(`jobs contains unknown customerId: ${job.customerId}`);
    }
  }

  for (const estimate of payload.estimates) {
    if (!customerIds.has(estimate.customerId)) {
      throw new ValidationError(`estimates contains unknown customerId: ${estimate.customerId}`);
    }
  }

  for (const invoice of payload.invoices) {
    if (!customerIds.has(invoice.customerId)) {
      throw new ValidationError(`invoices contains unknown customerId: ${invoice.customerId}`);
    }
  }

  for (const followup of payload.followups) {
    if (!customerIds.has(followup.customerId)) {
      throw new ValidationError(`followups contains unknown customerId: ${followup.customerId}`);
    }
  }
}

function validateStatePayload(rawBody: unknown, request: Request, env: Env): StatePayload {
  const body = asRecord(rawBody, "request body");
  const owner = resolveOwnerFromRequest(request, env, typeof body.owner === "string" ? body.owner : null);
  const stateVersion = normalizeStateVersion(body.stateVersion);

  const customers = asArray(body.customers ?? [], "customers").map(validateCustomer);
  const jobs = asArray(body.jobs ?? [], "jobs").map(validateJob);
  const estimates = asArray(body.estimates ?? [], "estimates").map(validateEstimate);
  const invoices = asArray(body.invoices ?? [], "invoices").map(validateInvoice);
  const followups = asArray(body.followups ?? [], "followups").map(validateFollowUp);

  ensureUniqueIds(customers, "customers");
  ensureUniqueIds(jobs, "jobs");
  ensureUniqueIds(estimates, "estimates");
  ensureUniqueIds(invoices, "invoices");
  ensureUniqueIds(followups, "followups");

  const payload: StatePayload = {
    owner,
    stateVersion,
    customers,
    jobs,
    estimates,
    invoices,
    followups,
  };

  validateRelationships(payload);
  return payload;
}

async function getOwnerMeta(db: D1Database, ownerEmail: string): Promise<OwnerMeta | null> {
  const row = await db
    .prepare(
      `
      SELECT email, name, created_at, updated_at, state_version
      FROM owners
      WHERE email = ?
      LIMIT 1
      `,
    )
    .bind(ownerEmail)
    .first<{
      email: string;
      name: string | null;
      created_at: string;
      updated_at: string | null;
      state_version: number | null;
    }>();

  if (!row) {
    return null;
  }

  return {
    email: row.email,
    name: row.name ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    stateVersion: row.state_version ?? 0,
  };
}

async function readState(db: D1Database, ownerEmail: string): Promise<ApiState> {
  const owner = await getOwnerMeta(db, ownerEmail);

  const customersResult = await db
    .prepare(
      `
      SELECT id, name, phone, email, address, tag, notes, created_at AS createdAt
      FROM customers
      WHERE owner_email = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .bind(ownerEmail)
    .all<Customer>();

  const jobsResult = await db
    .prepare(
      `
      SELECT
        id,
        customer_id AS customerId,
        customer_name AS customerName,
        scheduled_date AS scheduledDate,
        scheduled_time AS scheduledTime,
        issue,
        status,
        notes,
        amount,
        photos,
        created_at AS createdAt,
        job_number AS jobNumber
      FROM jobs
      WHERE owner_email = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .bind(ownerEmail)
    .all<Job>();

  const estimatesResult = await db
    .prepare(
      `
      SELECT
        id,
        customer_id AS customerId,
        customer_name AS customerName,
        total,
        status,
        notes,
        created_at AS createdAt
      FROM estimates
      WHERE owner_email = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .bind(ownerEmail)
    .all<Estimate>();

  const invoicesResult = await db
    .prepare(
      `
      SELECT
        id,
        customer_id AS customerId,
        customer_name AS customerName,
        total,
        status,
        notes,
        payment_link AS paymentLink,
        created_at AS createdAt,
        job_number AS jobNumber
      FROM invoices
      WHERE owner_email = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .bind(ownerEmail)
    .all<Invoice>();

  const followupsResult = await db
    .prepare(
      `
      SELECT
        id,
        customer_id AS customerId,
        customer_name AS customerName,
        due_date AS dueDate,
        method,
        notes,
        done,
        created_at AS createdAt
      FROM followups
      WHERE owner_email = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .bind(ownerEmail)
    .all<FollowUp>();

  return {
    owner: ownerEmail,
    stateVersion: owner?.stateVersion ?? 0,
    lastSavedAt: owner?.updatedAt ?? "",
    customers: customersResult.results ?? [],
    jobs: jobsResult.results ?? [],
    estimates: estimatesResult.results ?? [],
    invoices: invoicesResult.results ?? [],
    followups: (followupsResult.results ?? []).map((row) => ({
      ...row,
      done: Boolean(row.done),
    })),
  };
}

async function writeState(db: D1Database, payload: StatePayload): Promise<ApiState> {
  const now = new Date().toISOString();
  const owner = await getOwnerMeta(db, payload.owner);
  const currentVersion = owner?.stateVersion ?? 0;

  if (payload.stateVersion !== currentVersion) {
    throw new ValidationError("State is stale. Reload from Worker.", 409);
  }

  const nextVersion = currentVersion + 1;
  const ownerCreatedAt = owner?.createdAt ?? now;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `
        INSERT INTO owners (email, name, created_at, updated_at, state_version)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at,
          state_version = excluded.state_version
        `,
      )
      .bind(payload.owner, "", ownerCreatedAt, now, nextVersion),

    db.prepare(`DELETE FROM followups WHERE owner_email = ?`).bind(payload.owner),
    db.prepare(`DELETE FROM invoices WHERE owner_email = ?`).bind(payload.owner),
    db.prepare(`DELETE FROM estimates WHERE owner_email = ?`).bind(payload.owner),
    db.prepare(`DELETE FROM jobs WHERE owner_email = ?`).bind(payload.owner),
    db.prepare(`DELETE FROM customers WHERE owner_email = ?`).bind(payload.owner),
  ];

  for (const customer of payload.customers) {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO customers (
            id, owner_email, name, phone, email, address, tag, notes, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          customer.id,
          payload.owner,
          customer.name,
          customer.phone,
          customer.email,
          customer.address,
          customer.tag,
          customer.notes,
          customer.createdAt || now,
        ),
    );
  }

  for (const job of payload.jobs) {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO jobs (
            id,
            owner_email,
            customer_id,
            customer_name,
            scheduled_date,
            scheduled_time,
            issue,
            status,
            notes,
            amount,
            photos,
            created_at,
            job_number
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          job.id,
          payload.owner,
          job.customerId,
          job.customerName,
          job.scheduledDate,
          job.scheduledTime,
          job.issue,
          job.status,
          job.notes,
          job.amount,
          job.photos,
          job.createdAt || now,
          job.jobNumber,
        ),
    );
  }

  for (const estimate of payload.estimates) {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO estimates (
            id,
            owner_email,
            customer_id,
            customer_name,
            total,
            status,
            notes,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          estimate.id,
          payload.owner,
          estimate.customerId,
          estimate.customerName,
          estimate.total,
          estimate.status,
          estimate.notes,
          estimate.createdAt || now,
        ),
    );
  }

  for (const invoice of payload.invoices) {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO invoices (
            id,
            owner_email,
            customer_id,
            customer_name,
            total,
            status,
            notes,
            payment_link,
            created_at,
            job_number
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          invoice.id,
          payload.owner,
          invoice.customerId,
          invoice.customerName,
          invoice.total,
          invoice.status,
          invoice.notes,
          invoice.paymentLink,
          invoice.createdAt || now,
          invoice.jobNumber,
        ),
    );
  }

  for (const followup of payload.followups) {
    statements.push(
      db
        .prepare(
          `
          INSERT INTO followups (
            id,
            owner_email,
            customer_id,
            customer_name,
            due_date,
            method,
            notes,
            done,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .bind(
          followup.id,
          payload.owner,
          followup.customerId,
          followup.customerName,
          followup.dueDate,
          followup.method,
          followup.notes,
          followup.done ? 1 : 0,
          followup.createdAt || now,
        ),
    );
  }

  await db.batch(statements);

  return readState(db, payload.owner);
}

async function proxyInvoiceEmail(
  payload: EmailProxyPayload,
  env: Env,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const emailServiceUrl = (env.EMAIL_SERVICE_URL ?? "").trim();
  const emailServiceApiKey = (env.EMAIL_SERVICE_API_KEY ?? "").trim();

  if (!emailServiceUrl || !emailServiceApiKey) {
    throw new ValidationError("Email proxy is not configured.", 500);
  }

  const endpoint = `${emailServiceUrl.replace(/\/+$/, "")}/send-invoice-email`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": emailServiceApiKey,
      },
      body: JSON.stringify({
        to_email: payload.toEmail,
        customer_name: payload.customerName,
        amount: payload.amount,
        status: payload.status,
        job_number: payload.jobNumber,
        notes: payload.notes,
        payment_url: payload.paymentUrl,
      }),
    });
  } catch (err) {
    // Render down / wrong URL / DNS / etc.
    return {
      status: 502,
      body: {
        ok: false,
        error: "Email service unreachable.",
        details: err instanceof Error ? err.message : String(err),
      },
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = { ok: false, error: "Email service returned a non-JSON response." };
  }

  return { status: response.status, body };
}

