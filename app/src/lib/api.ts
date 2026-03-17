// app/src/lib/api.ts
/**
 * Frontend talks ONLY to the Worker.
 * The Worker proxies to the email-service using server-side secrets.
 */

const API_BASE_URL = requireEnv("VITE_API_BASE_URL", import.meta.env.VITE_API_BASE_URL).replace(/\/+$/, "");
const OWNER_EMAIL = normalizeOwnerEmail(requireEnv("VITE_OWNER_EMAIL", import.meta.env.VITE_OWNER_EMAIL));
const API_AUTH_TOKEN = (import.meta.env.VITE_API_AUTH_TOKEN as string | undefined)?.trim() || "";

export type Health = {
  ok: boolean;
  service: string;
  authRequired?: boolean;
  emailProxyConfigured?: boolean;
};

export class ApiRequestError extends Error {
  readonly status?: number;
  readonly retriable: boolean;

  constructor(message: string, opts: { status?: number; retriable: boolean }) {
    super(message);
    this.name = "ApiRequestError";
    this.status = opts.status;
    this.retriable = opts.retriable;
  }
}

export type Customer = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  tag?: string;
  notes?: string;
  createdAt: string;
};

export type Job = {
  id: string;
  customerId: string;
  customerName: string;
  scheduledDate?: string;
  scheduledTime?: string;
  jobNumber?: string;
  issue: string;
  status: string;
  notes?: string;
  amount?: number;
  photos?: number;
  createdAt: string;
};

export type Estimate = {
  id: string;
  customerId: string;
  customerName: string;
  title: string;
  total?: number;
  status: string;
  notes?: string;
  createdAt: string;
};

export type Invoice = {
  id: string;
  customerId: string;
  customerName: string;
  jobNumber?: string;
  total?: number;
  status: string;
  notes?: string;
  paymentLink?: string;
  createdAt: string;
};

export type Followup = {
  id: string;
  customerId: string;
  customerName: string;
  type: string;
  dueDate: string;
  status: string;
  notes?: string;
  createdAt: string;
};

export type AppState = {
  owner?: string;
  stateVersion?: number;
  lastSavedAt?: string | null;
  customers: Customer[];
  jobs: Job[];
  estimates: Estimate[];
  invoices: Invoice[];
  followups: Followup[];
};

export type SaveStateResponse = {
  ok: true;
  owner: string;
  stateVersion: number;
  updatedAt: string;
};

function normalizeOwnerEmail(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function withApiAuth(headers: Record<string, string> = {}): Record<string, string> {
  if (API_AUTH_TOKEN) headers["x-api-token"] = API_AUTH_TOKEN;
  return headers;
}

async function parseJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

export function isRetriableEmailError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // network/offline
  if (err instanceof ApiRequestError) return err.retriable;
  return false;
}

export async function getHealth(): Promise<Health> {
  const res = await fetch(`${API_BASE_URL}/api/health`, { headers: withApiAuth() });
  if (!res.ok) {
    throw new ApiRequestError(`Health check failed: ${res.status}`, {
      status: res.status,
      retriable: isRetriableStatus(res.status),
    });
  }
  return (await res.json()) as Health;
}

export async function getState(): Promise<AppState> {
  const res = await fetch(`${API_BASE_URL}/api/state?owner=${encodeURIComponent(OWNER_EMAIL)}`, {
    headers: withApiAuth(),
  });

  const data = await parseJson<AppState & { error?: string }>(res);
  if (!res.ok) {
    throw new ApiRequestError(data?.error || `State fetch failed: ${res.status}`, {
      status: res.status,
      retriable: isRetriableStatus(res.status),
    });
  }
  return data as AppState;
}

export async function saveState(state: AppState): Promise<SaveStateResponse> {
  const res = await fetch(`${API_BASE_URL}/api/state`, {
    method: "POST",
    headers: withApiAuth({
      "Content-Type": "application/json",
      "x-owner-email": OWNER_EMAIL,
    }),
    body: JSON.stringify({
      ...state,
      owner: OWNER_EMAIL,
      stateVersion: state.stateVersion ?? 0,
    }),
  });

  const data = await parseJson<SaveStateResponse & { error?: string; message?: string }>(res);
  if (!res.ok) {
    throw new ApiRequestError(data?.message || data?.error || `State save failed: ${res.status}`, {
      status: res.status,
      retriable: isRetriableStatus(res.status),
    });
  }
  return data as SaveStateResponse;
}

export async function sendInvoiceEmail(payload: {
  to_email: string;
  customer_name: string;
  amount: number;
  status: string;
  job_number?: string;
  notes?: string;
  payment_url?: string;
}): Promise<unknown> {
  let res: Response;

  try {
    res = await fetch(`${API_BASE_URL}/api/send-invoice-email`, {
      method: "POST",
      headers: withApiAuth({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        toEmail: payload.to_email,
        customerName: payload.customer_name,
        amount: payload.amount,
        status: payload.status,
        jobNumber: payload.job_number ?? "",
        notes: payload.notes ?? "",
        paymentUrl: payload.payment_url ?? "",
      }),
    });
  } catch {
    throw new ApiRequestError("Email send failed: network error", { retriable: true });
  }

  const data = await parseJson<{ error?: string }>(res);
  if (!res.ok) {
    throw new ApiRequestError(data?.error || `Email send failed: ${res.status}`, {
      status: res.status,
      retriable: isRetriableStatus(res.status),
    });
  }

  return data;
}