import { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  getHealth,
  getState,
  saveState,
  isRetriableEmailError,
  sendInvoiceEmail as sendInvoiceEmailApi,
  type AppState,
  type Customer,
  type Invoice,
  type Job,
} from "./lib/api";

type Health = {
  ok: boolean;
  service: string;
};

type TabKey =
  | "dashboard"
  | "customers"
  | "jobs"
  | "estimates"
  | "invoices"
  | "followups";

const tabs: { key: TabKey; label: string }[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "customers", label: "Customers" },
  { key: "jobs", label: "Jobs" },
  { key: "estimates", label: "Estimates" },
  { key: "invoices", label: "Invoices" },
  { key: "followups", label: "Follow-Ups" },
];

const CENTS_PER_DOLLAR = 100;

type PendingEmailJob = {
  id: string;
  invoiceId: string;
  label: string;
  payload: Parameters<typeof sendInvoiceEmailApi>[0];
  createdAt: string;
};

const LOCAL_STATE_KEY = "arista.ops.cachedState.v1";
const PENDING_EMAILS_KEY = "arista.ops.pendingEmails.v1";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readCachedState(): AppState | null {
  if (!canUseStorage()) return null;

  try {
    const raw = window.localStorage.getItem(LOCAL_STATE_KEY);
    return raw ? (JSON.parse(raw) as AppState) : null;
  } catch {
    return null;
  }
}

function writeCachedState(state: AppState | null) {
  if (!canUseStorage() || !state) return;

  try {
    window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures so the main app path keeps working.
  }
}

function readPendingEmails(): PendingEmailJob[] {
  if (!canUseStorage()) return [];

  try {
    const raw = window.localStorage.getItem(PENDING_EMAILS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingEmailJob[]) : [];
  } catch {
    return [];
  }
}

function writePendingEmails(items: PendingEmailJob[]) {
  if (!canUseStorage()) return;

  try {
    window.localStorage.setItem(PENDING_EMAILS_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage failures so the main app path keeps working.
  }
}

function queuePendingEmail(job: PendingEmailJob) {
  const pending = readPendingEmails();
  pending.push(job);
  writePendingEmails(pending);
}


function money(value: unknown) {
  const cents = Number(value || 0);
  const dollars = Number.isFinite(cents) ? cents / CENTS_PER_DOLLAR : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

function dollarsToCents(value: string) {
  const dollars = Number(value || 0);
  if (!Number.isFinite(dollars)) return 0;
  return Math.round(dollars * CENTS_PER_DOLLAR);
}

function centsToDollars(value: unknown) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents)) return 0;
  return cents / CENTS_PER_DOLLAR;
}

function serializeState(value: unknown) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    // Treat unserializable state as dirty to avoid accidental data loss.
    return String(Date.now());
  }
}

function makeJobNumber() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `JOB-${stamp}-${rand}`;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [baselineSnapshot, setBaselineSnapshot] = useState("");
  const stateSnapshot = useMemo(() => serializeState(state), [state]);
  const isDirty = useMemo(
    () => Boolean(state) && baselineSnapshot !== "" && stateSnapshot !== baselineSnapshot,
    [baselineSnapshot, stateSnapshot, state]
  );

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [emailSendingId, setEmailSendingId] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [pendingEmailsCount, setPendingEmailsCount] = useState(() => readPendingEmails().length);
  const [syncingPendingEmails, setSyncingPendingEmails] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");

  const [jobCustomerId, setJobCustomerId] = useState("");
  const [jobIssue, setJobIssue] = useState("");
  const [jobStatus, setJobStatus] = useState("Scheduled");
  const [jobDate, setJobDate] = useState("");
  const [jobTime, setJobTime] = useState("");

  const [invoiceJobId, setInvoiceJobId] = useState("");
  const [invoiceCustomerId, setInvoiceCustomerId] = useState("");
  const [invoiceJobNumber, setInvoiceJobNumber] = useState("");
  const [invoiceTotal, setInvoiceTotal] = useState("");
  const [invoiceStatus, setInvoiceStatus] = useState("Unpaid");
  const [invoiceNotes, setInvoiceNotes] = useState("");

  async function load(): Promise<boolean> {
    try {
      setLoading(true);
      setError("");
      const [healthData, stateData] = await Promise.all([getHealth(), getState()]);
      setHealth(healthData);
      setState(stateData);
      writeCachedState(stateData);
      setBaselineSnapshot(serializeState(stateData));
      return true;
    } catch (err) {
      const cachedState = readCachedState();
      if (cachedState) {
        setHealth({ ok: false, service: "cached-offline-state" });
        setState(cachedState);
        setBaselineSnapshot(serializeState(cachedState));
        setError("Offline. Loaded cached data from this device.");
        return true;
      }

      const message = err instanceof Error ? err.message : "Unknown error occurred";
      setError(message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function reloadFromWorker() {
    const requiresConfirm = isDirty;
    if (requiresConfirm) {
      const ok = window.confirm(
        "Reload from Worker?\n\nWarning: Unsaved information will be lost."
      );
      if (!ok) return;
    }

    const ok = await load();
    if (ok) {
      setActionMessage(
        requiresConfirm
          ? "Reloaded from Worker. Unsaved changes were discarded."
          : "Reloaded from Worker."
      );
    }
  }

  async function saveToWorker() {
    if (!state) return;

    try {
      setSaving(true);
      setError("");
      setActionMessage("");
      const saved = await saveState(state);
      const nextState = {
        ...state,
        owner: saved.owner,
        stateVersion: saved.stateVersion,
        lastSavedAt: saved.updatedAt,
      };
      setState(nextState);
      writeCachedState(nextState);
      setBaselineSnapshot(serializeState(nextState));
      setActionMessage("Saved to Worker + D1.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function processPendingEmails() {
    if (!navigator.onLine) return;

    const pending = readPendingEmails();
    if (!pending.length) {
      setPendingEmailsCount(0);
      return;
    }

    try {
      setSyncingPendingEmails(true);

      const remaining: PendingEmailJob[] = [];
      let sentCount = 0;
      let droppedCount = 0;

      for (const job of pending) {
        try {
          await sendInvoiceEmailApi(job.payload);
          sentCount += 1;
        } catch (err) {
          if (isRetriableEmailError(err)) {
            remaining.push(job);
          } else {
            droppedCount += 1;
          }
        }
      }

      writePendingEmails(remaining);
      setPendingEmailsCount(remaining.length);

      if (droppedCount > 0) {
        setError(
          `${droppedCount} queued email${droppedCount === 1 ? "" : "s"} could not be sent (non-retriable). Fix the email settings and resend.`
        );
      }

      if (sentCount > 0) {
        setActionMessage(
          remaining.length
            ? `${sentCount} queued email${sentCount === 1 ? "" : "s"} sent. ${remaining.length} still pending.`
            : `${sentCount} queued email${sentCount === 1 ? "" : "s"} sent.`
        );
      }
    } finally {
      setSyncingPendingEmails(false);
    }
  }

  function clearCustomerForm() {
    setCustomerName("");
    setCustomerPhone("");
    setCustomerEmail("");
    setCustomerAddress("");
  }

  function clearJobForm() {
    setJobCustomerId("");
    setJobIssue("");
    setJobStatus("Scheduled");
    setJobDate("");
    setJobTime("");
  }

  function clearInvoiceForm() {
    setInvoiceJobId("");
    setInvoiceCustomerId("");
    setInvoiceJobNumber("");
    setInvoiceTotal("");
    setInvoiceStatus("Unpaid");
    setInvoiceNotes("");
  }

  function addCustomer() {
    if (!customerName.trim()) return;

    const newCustomer: Customer = {
      id: crypto.randomUUID(),
      name: customerName.trim(),
      phone: customerPhone.trim(),
      email: customerEmail.trim(),
      address: customerAddress.trim(),
      tag: "Lead",
      notes: "",
      createdAt: new Date().toISOString(),
    };

    setState((prev) =>
      prev
        ? {
            ...prev,
            customers: [newCustomer, ...(prev.customers ?? [])],
          }
        : prev
    );

    clearCustomerForm();
    setActionMessage("Customer added locally. Click Save To Worker.");
    setActiveTab("customers");
  }

  function deleteCustomer(customerId: string) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            customers: (prev.customers ?? []).filter((customer) => customer.id !== customerId),
            jobs: (prev.jobs ?? []).filter((job) => job.customerId !== customerId),
            estimates: (prev.estimates ?? []).filter((estimate) => estimate.customerId !== customerId),
            invoices: (prev.invoices ?? []).filter((invoice) => invoice.customerId !== customerId),
            followups: (prev.followups ?? []).filter((followup) => followup.customerId !== customerId),
          }
        : prev
    );

    setActionMessage("Customer and related records removed locally. Click Save To Worker.");
  }

  function addJob() {
    if (!jobCustomerId || !jobIssue.trim() || !state) return;

    const customer = (state.customers ?? []).find((c) => c.id === jobCustomerId);
    if (!customer) return;

    const newJob: Job = {
      id: crypto.randomUUID(),
      customerId: customer.id,
      customerName: customer.name,
      scheduledDate: jobDate || "",
      scheduledTime: jobTime || "",
      jobNumber: makeJobNumber(),
      issue: jobIssue.trim(),
      status: jobStatus,
      notes: "",
      amount: 0,
      photos: 0,
      createdAt: new Date().toISOString(),
    };

    setState((prev) =>
      prev
        ? {
            ...prev,
            jobs: [newJob, ...(prev.jobs ?? [])],
          }
        : prev
    );

    clearJobForm();
    setActionMessage("Job added locally. Click Save To Worker.");
    setActiveTab("jobs");
  }

  function deleteJob(jobId: string) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            jobs: (prev.jobs ?? []).filter((job) => job.id !== jobId),
          }
        : prev
    );

    setActionMessage("Job removed locally. Click Save To Worker.");
  }

  function fillInvoiceFromJob(jobId: string, openInvoicesTab = false) {
    setInvoiceJobId(jobId);

    if (!state) return;
    const job = (state.jobs ?? []).find((j) => j.id === jobId);
    if (!job) return;

    setInvoiceCustomerId(job.customerId || "");
    setInvoiceJobNumber(job.jobNumber || "");
    setInvoiceNotes(job.issue || "");

    if (openInvoicesTab) {
      setActiveTab("invoices");
      setActionMessage("Invoice form filled from selected job.");
    }
  }

  function addInvoice() {
    if (!invoiceCustomerId || !invoiceTotal.trim() || !state) return;

    const customer = (state.customers ?? []).find((c) => c.id === invoiceCustomerId);
    if (!customer) return;

    const newInvoice: Invoice = {
      id: crypto.randomUUID(),
      customerId: customer.id,
      customerName: customer.name,
      jobNumber: invoiceJobNumber.trim(),
      total: dollarsToCents(invoiceTotal),
      status: invoiceStatus,
      notes: invoiceNotes.trim(),
      paymentLink: "",
      createdAt: new Date().toISOString(),
    };

    setState((prev) =>
      prev
        ? {
            ...prev,
            invoices: [newInvoice, ...(prev.invoices ?? [])],
          }
        : prev
    );

    clearInvoiceForm();
    setActionMessage("Invoice added locally. Click Save To Worker.");
    setActiveTab("invoices");
  }

  function deleteInvoice(invoiceId: string) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            invoices: (prev.invoices ?? []).filter((invoice) => invoice.id !== invoiceId),
          }
        : prev
    );

    setActionMessage("Invoice removed locally. Click Save To Worker.");
  }

  function toggleInvoicePaid(invoiceId: string) {
    setState((prev) =>
      prev
        ? {
            ...prev,
            invoices: (prev.invoices ?? []).map((invoice) =>
              invoice.id === invoiceId
                ? {
                    ...invoice,
                    status: invoice.status === "Paid" ? "Unpaid" : "Paid",
                  }
                : invoice
            ),
          }
        : prev
    );

    setActionMessage("Invoice status changed locally. Click Save To Worker.");
  }

  async function emailInvoice(invoice: Invoice) {
    if (!state) return;

    const customer = (state.customers ?? []).find((c) => c.id === invoice.customerId);
    const toEmail = customer?.email?.trim();

    if (!toEmail) {
      setError("This customer does not have an email address.");
      return;
    }

    const payload = {
      to_email: toEmail,
      customer_name: invoice.customerName,
      amount: centsToDollars(invoice.total),
      status: invoice.status,
      job_number: invoice.jobNumber || "",
      notes: invoice.notes || "",
      payment_url: invoice.paymentLink || "",
    };

    if (!navigator.onLine) {
      queuePendingEmail({
        id: crypto.randomUUID(),
        invoiceId: invoice.id,
        label: invoice.status === "Paid" ? "Paid receipt" : "Invoice",
        payload,
        createdAt: new Date().toISOString(),
      });
      setPendingEmailsCount(readPendingEmails().length);
      setActionMessage(
        invoice.status === "Paid"
          ? "Offline. Paid receipt queued and will send when connection returns."
          : "Offline. Invoice email queued and will send when connection returns."
      );
      setError("");
      return;
    }

    try {
      setError("");
      setActionMessage("");
      setEmailSendingId(invoice.id);

      await sendInvoiceEmailApi(payload);

      setActionMessage(invoice.status === "Paid" ? "Paid receipt email sent." : "Invoice email sent.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Email send failed";

      if (isRetriableEmailError(err)) {
        queuePendingEmail({
          id: crypto.randomUUID(),
          invoiceId: invoice.id,
          label: invoice.status === "Paid" ? "Paid receipt" : "Invoice",
          payload,
          createdAt: new Date().toISOString(),
        });
        setPendingEmailsCount(readPendingEmails().length);
        setError(`${message} Email queued for retry when connection returns.`);
      } else {
        setError(message);
      }
    } finally {
      setEmailSendingId("");
    }
  }

  useEffect(() => {
    load().then(() => {
      void processPendingEmails();
    });

    function handleOnline() {
      setActionMessage("Back online. Syncing queued email actions...");
      void processPendingEmails();
      void load();
    }

    function handleOffline() {
      setHealth((prev) => (prev ? { ...prev, ok: false } : { ok: false, service: "offline" }));
      setActionMessage("Offline mode. You can keep working with cached data.");
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (state) {
      writeCachedState(state);
    }
  }, [state]);


  const totals = useMemo(() => {
    const invoices = state?.invoices ?? [];
    const unpaid = invoices.filter((x) => x.status !== "Paid");
    const paid = invoices.filter((x) => x.status === "Paid");

    return {
      customers: state?.customers?.length ?? 0,
      jobs: state?.jobs?.length ?? 0,
      estimates: state?.estimates?.length ?? 0,
      invoices: invoices.length,
      followups: state?.followups?.length ?? 0,
      unpaidAmount: unpaid.reduce((sum, x) => sum + Number(x.total || 0), 0),
      paidAmount: paid.reduce((sum, x) => sum + Number(x.total || 0), 0),
    };
  }, [state]);

  const sectionTitle = tabs.find((t) => t.key === activeTab)?.label ?? "Dashboard";

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <aside style={styles.sidebar}>
          <div>
            <div style={styles.brandBox}>
              <div style={styles.brandIcon}>A</div>
              <div>
                <div style={styles.brandTitle}>Arista Ops</div>
                <div style={styles.brandSub}>Cloudflare + D1</div>
              </div>
            </div>

            <div style={styles.nav}>
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    ...styles.navButton,
                    ...(activeTab === tab.key ? styles.navButtonActive : {}),
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div style={styles.sidebarFooter}>
            <div style={styles.ownerCard}>
              <div style={styles.ownerLabel}>Owner</div>
              <div style={styles.ownerEmail}>{state?.owner || "Not loaded"}</div>
              <div style={styles.ownerStatus}>API: {health?.ok ? "Connected" : "Offline"}</div>
              <div style={styles.ownerStatus}>
                Version: {state?.stateVersion ?? 0}
              </div>
              <div style={styles.ownerStatus}>
                Last saved: {state?.lastSavedAt ? new Date(state.lastSavedAt).toLocaleString() : "Never"}
              </div>
              <div style={styles.ownerStatus}>
                Pending emails: {pendingEmailsCount}
                {syncingPendingEmails ? " (syncing)" : ""}
              </div>
            </div>
          </div>
        </aside>

        <main style={styles.main}>
          <div style={styles.topbar}>
            <div>
              <h1 style={styles.heading}>{sectionTitle}</h1>
              <p style={styles.subheading}>Working UI connected to your local Cloudflare Worker.</p>
            </div>

            <div style={styles.topbarActions}>
              <div
                style={{
                  ...styles.pill,
                  background: health?.ok ? "#dcfce7" : "#fee2e2",
                  color: health?.ok ? "#166534" : "#991b1b",
                }}
              >
                {health?.ok ? "Worker Healthy" : "Worker Not Ready"}
              </div>

              <button
                onClick={reloadFromWorker}
                title="Warning: Unsaved information will be lost."
                aria-label="Reload from Worker (warning: unsaved information will be lost)"
                style={styles.secondaryButton}
              >
                {loading ? "Reloading..." : "Reload From Worker"}
              </button>

              <button onClick={saveToWorker} style={styles.primaryButton}>
                {saving ? "Saving..." : "Save To Worker"}
              </button>
            </div>
          </div>

          {error && (
            <div style={styles.errorBox}>
              <strong>Error:</strong> {error}
            </div>
          )}

          {actionMessage && <div style={styles.successBox}>{actionMessage}</div>}

          {activeTab === "dashboard" && (
            <>
              <div style={styles.grid4}>
                <MetricCard label="Customers" value={String(totals.customers)} />
                <MetricCard label="Jobs" value={String(totals.jobs)} />
                <MetricCard label="Unpaid" value={money(totals.unpaidAmount)} />
                <MetricCard label="Collected" value={money(totals.paidAmount)} />
              </div>

              <div style={styles.grid2}>
                <Section title="Quick Snapshot">
                  <div style={styles.listItem}>Estimates: {totals.estimates}</div>
                  <div style={styles.listItem}>Invoices: {totals.invoices}</div>
                  <div style={styles.listItem}>Follow-Ups: {totals.followups}</div>
                  <div style={styles.listItem}>Owner: {state?.owner || "not loaded"}</div>
                </Section>

                <Section title="Next Build Steps">
                  <div style={styles.listItem}>Email invoice / receipt</div>
                  <div style={styles.listItem}>Edit customer, job, invoice</div>
                  <div style={styles.listItem}>Follow-up reminders</div>
                  <div style={styles.listItem}>Deploy to Cloudflare</div>
                </Section>
              </div>
            </>
          )}

          {activeTab === "customers" && (
            <div style={styles.grid2}>
              <Section title="Add Customer">
                <div style={styles.formGrid}>
                  <input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Customer name"
                    style={styles.input}
                  />
                  <input
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="Phone"
                    style={styles.input}
                  />
                  <input
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    placeholder="Email"
                    style={styles.input}
                  />
                  <input
                    value={customerAddress}
                    onChange={(e) => setCustomerAddress(e.target.value)}
                    placeholder="Service address"
                    style={styles.input}
                  />
                  <div style={styles.buttonRow}>
                    <button onClick={addCustomer} style={styles.primaryButton}>
                      Add Customer
                    </button>
                    <button onClick={saveToWorker} style={styles.secondaryButton}>
                      {saving ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              </Section>

              <Section title="Customers">
                {(state?.customers ?? []).length === 0 ? (
                  <EmptyText text="No customers yet." />
                ) : (
                  (state?.customers ?? []).map((customer) => (
                    <div key={customer.id} style={styles.rowCard}>
                      <div>
                        <div style={styles.rowTitle}>{customer.name}</div>
                        <div style={styles.rowSub}>{customer.address || "No address"}</div>
                        <div style={styles.smallMuted}>{customer.email || "No email"}</div>
                      </div>

                      <div style={styles.rowRight}>
                        <div>{customer.phone || "No phone"}</div>
                        <div style={styles.smallMuted}>{customer.tag || "No tag"}</div>
                        <button onClick={() => deleteCustomer(customer.id)} style={styles.deleteButton}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </Section>
            </div>
          )}

          {activeTab === "jobs" && (
            <div style={styles.grid2}>
              <Section title="Add Job">
                <div style={styles.formGrid}>
                  <select
                    value={jobCustomerId}
                    onChange={(e) => setJobCustomerId(e.target.value)}
                    style={styles.input}
                  >
                    <option value="">Choose customer</option>
                    {(state?.customers ?? []).map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>

                  <input
                    value={jobIssue}
                    onChange={(e) => setJobIssue(e.target.value)}
                    placeholder="Issue"
                    style={styles.input}
                  />

                  <select
                    value={jobStatus}
                    onChange={(e) => setJobStatus(e.target.value)}
                    style={styles.input}
                  >
                    <option value="Scheduled">Scheduled</option>
                    <option value="Open">Open</option>
                    <option value="In Progress">In Progress</option>
                    <option value="Completed">Completed</option>
                  </select>

                  <input
                    value={jobDate}
                    onChange={(e) => setJobDate(e.target.value)}
                    type="date"
                    style={styles.input}
                  />

                  <input
                    value={jobTime}
                    onChange={(e) => setJobTime(e.target.value)}
                    type="time"
                    style={styles.input}
                  />

                  <div style={styles.buttonRow}>
                    <button onClick={addJob} style={styles.primaryButton}>
                      Add Job
                    </button>
                    <button onClick={saveToWorker} style={styles.secondaryButton}>
                      {saving ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              </Section>

              <Section title="Jobs">
                {(state?.jobs ?? []).length === 0 ? (
                  <EmptyText text="No jobs yet." />
                ) : (
                  (state?.jobs ?? []).map((job) => (
                    <div key={job.id} style={styles.rowCard}>
                      <div>
                        <div style={styles.rowTitle}>{job.customerName}</div>
                        <div style={styles.rowSub}>
                          {job.jobNumber ? `${job.jobNumber} · ` : ""}
                          {job.issue}
                        </div>
                      </div>

                      <div style={styles.rowRight}>
                        <div>{job.status}</div>
                        <div style={styles.smallMuted}>
                          {job.scheduledDate || "No date"} {job.scheduledTime || ""}
                        </div>
                        <button
                          onClick={() => fillInvoiceFromJob(job.id, true)}
                          style={styles.secondarySmallButton}
                        >
                          Create Invoice
                        </button>
                        <button onClick={() => deleteJob(job.id)} style={styles.deleteButton}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </Section>
            </div>
          )}

          {activeTab === "estimates" && (
            <Section title="Estimates">
              {(state?.estimates ?? []).length === 0 ? (
                <EmptyText text="No estimates yet." />
              ) : (
                (state?.estimates ?? []).map((estimate) => (
                  <div key={estimate.id} style={styles.rowCard}>
                    <div>
                      <div style={styles.rowTitle}>{estimate.title}</div>
                      <div style={styles.rowSub}>{estimate.customerName}</div>
                    </div>
                    <div style={styles.rowRight}>
                      <div>{money(estimate.total)}</div>
                      <div style={styles.smallMuted}>{estimate.status}</div>
                    </div>
                  </div>
                ))
              )}
            </Section>
          )}

          {activeTab === "invoices" && (
            <div style={styles.grid2}>
              <Section title="Add Invoice">
                <div style={styles.formGrid}>
                  <select
                    value={invoiceJobId}
                    onChange={(e) => fillInvoiceFromJob(e.target.value)}
                    style={styles.input}
                  >
                    <option value="">Choose job</option>
                    {(state?.jobs ?? []).map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.jobNumber ? `${job.jobNumber} · ` : ""}
                        {job.customerName} · {job.issue}
                      </option>
                    ))}
                  </select>

                  <select
                    value={invoiceCustomerId}
                    onChange={(e) => setInvoiceCustomerId(e.target.value)}
                    style={styles.input}
                  >
                    <option value="">Choose customer</option>
                    {(state?.customers ?? []).map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name}
                      </option>
                    ))}
                  </select>

                  <input
                    value={invoiceTotal}
                    onChange={(e) => setInvoiceTotal(e.target.value)}
                    placeholder="Total (USD)"
                    type="number"
                    min="0"
                    step="0.01"
                    style={styles.input}
                  />

                  <select
                    value={invoiceStatus}
                    onChange={(e) => setInvoiceStatus(e.target.value)}
                    style={styles.input}
                  >
                    <option value="Unpaid">Unpaid</option>
                    <option value="Paid">Paid</option>
                    <option value="Pending Approval">Pending Approval</option>
                  </select>

                  <input
                    value={invoiceJobNumber}
                    onChange={(e) => setInvoiceJobNumber(e.target.value)}
                    placeholder="Job number"
                    style={styles.input}
                  />

                  <input
                    value={invoiceNotes}
                    onChange={(e) => setInvoiceNotes(e.target.value)}
                    placeholder="Notes"
                    style={styles.input}
                  />

                  <div style={styles.buttonRow}>
                    <button onClick={addInvoice} style={styles.primaryButton}>
                      Add Invoice
                    </button>
                    <button onClick={saveToWorker} style={styles.secondaryButton}>
                      {saving ? "Saving..." : "Save Changes"}
                    </button>
                  </div>
                </div>
              </Section>

              <Section title="Invoices">
                {(state?.invoices ?? []).length === 0 ? (
                  <EmptyText text="No invoices yet." />
                ) : (
                  (state?.invoices ?? []).map((invoice) => (
                    <div key={invoice.id} style={styles.rowCard}>
                      <div>
                        <div style={styles.rowTitle}>{invoice.customerName}</div>
                        <div style={styles.rowSub}>
                          {invoice.jobNumber ? `${invoice.jobNumber} · ` : ""}
                          {invoice.notes || "Invoice"}
                        </div>
                      </div>

                      <div style={styles.rowRight}>
                        <div>{money(invoice.total)}</div>
                        <div style={styles.smallMuted}>{invoice.status}</div>
                        <button
                          onClick={() => toggleInvoicePaid(invoice.id)}
                          style={styles.secondarySmallButton}
                        >
                          {invoice.status === "Paid" ? "Mark Unpaid" : "Mark Paid"}
                        </button>
                        <button
                          onClick={() => emailInvoice(invoice)}
                          style={styles.secondarySmallButton}
                          disabled={emailSendingId === invoice.id}
                        >
                          {emailSendingId === invoice.id
                            ? "Sending..."
                            : invoice.status === "Paid"
                              ? "Send Receipt"
                              : "Send Invoice"}
                        </button>
                        <button onClick={() => deleteInvoice(invoice.id)} style={styles.deleteButton}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </Section>
            </div>
          )}

          {activeTab === "followups" && (
            <Section title="Follow-Ups">
              {(state?.followups ?? []).length === 0 ? (
                <EmptyText text="No follow-ups yet." />
              ) : (
                (state?.followups ?? []).map((followup) => (
                  <div key={followup.id} style={styles.rowCard}>
                    <div>
                      <div style={styles.rowTitle}>{followup.customerName}</div>
                      <div style={styles.rowSub}>{followup.notes}</div>
                    </div>
                    <div style={styles.rowRight}>
                      <div>{followup.type}</div>
                      <div style={styles.smallMuted}>{followup.status}</div>
                    </div>
                  </div>
                ))
              )}
            </Section>
          )}
        </main>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metricCard}>
      <div style={styles.metricLabel}>{label}</div>
      <div style={styles.metricValue}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}

function EmptyText({ text }: { text: string }) {
  return <div style={styles.emptyText}>{text}</div>;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f8fafc",
    color: "#0f172a",
    fontFamily: "Arial, sans-serif",
  },
  shell: {
    display: "grid",
    gridTemplateColumns: "260px 1fr",
    minHeight: "100vh",
  },
  sidebar: {
    background: "#ffffff",
    borderRight: "1px solid #e2e8f0",
    padding: 20,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
  },
  brandBox: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginBottom: 24,
  },
  brandIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "#0f172a",
    color: "#ffffff",
    display: "grid",
    placeItems: "center",
    fontWeight: 700,
    fontSize: 20,
  },
  brandTitle: {
    fontSize: 20,
    fontWeight: 700,
  },
  brandSub: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 2,
  },
  nav: {
    display: "grid",
    gap: 8,
  },
  navButton: {
    textAlign: "left",
    border: "none",
    background: "#f8fafc",
    color: "#0f172a",
    padding: "12px 14px",
    borderRadius: 12,
    fontSize: 14,
    cursor: "pointer",
  },
  navButtonActive: {
    background: "#0f172a",
    color: "#ffffff",
  },
  sidebarFooter: {
    marginTop: 20,
  },
  ownerCard: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    padding: 14,
  },
  ownerLabel: {
    fontSize: 12,
    color: "#64748b",
    marginBottom: 6,
  },
  ownerEmail: {
    fontSize: 14,
    fontWeight: 700,
    wordBreak: "break-word",
  },
  ownerStatus: {
    fontSize: 12,
    color: "#475569",
    marginTop: 6,
  },
  main: {
    padding: 24,
  },
  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 24,
  },
  heading: {
    margin: 0,
    fontSize: 32,
    fontWeight: 800,
  },
  subheading: {
    margin: "6px 0 0",
    color: "#64748b",
  },
  topbarActions: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
  },
  pill: {
    padding: "10px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
  },
  primaryButton: {
    border: "none",
    background: "#0f172a",
    color: "#ffffff",
    borderRadius: 12,
    padding: "12px 16px",
    cursor: "pointer",
    fontWeight: 700,
  },
  secondaryButton: {
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#0f172a",
    borderRadius: 12,
    padding: "12px 16px",
    cursor: "pointer",
    fontWeight: 700,
  },
  secondarySmallButton: {
    marginTop: 8,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#0f172a",
    borderRadius: 10,
    padding: "8px 10px",
    cursor: "pointer",
    fontWeight: 700,
  },
  deleteButton: {
    marginTop: 8,
    border: "1px solid #fecaca",
    background: "#fff1f2",
    color: "#b91c1c",
    borderRadius: 10,
    padding: "8px 10px",
    cursor: "pointer",
    fontWeight: 700,
  },
  errorBox: {
    marginBottom: 20,
    padding: 14,
    background: "#fee2e2",
    border: "1px solid #fecaca",
    borderRadius: 12,
    color: "#991b1b",
  },
  successBox: {
    marginBottom: 20,
    padding: 14,
    background: "#dcfce7",
    border: "1px solid #bbf7d0",
    borderRadius: 12,
    color: "#166534",
  },
  grid4: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16,
    marginBottom: 16,
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 16,
  },
  metricCard: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 18,
  },
  metricLabel: {
    fontSize: 13,
    color: "#64748b",
    marginBottom: 10,
  },
  metricValue: {
    fontSize: 28,
    fontWeight: 800,
  },
  section: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 18,
    padding: 18,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 800,
  },
  listItem: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    padding: "12px 14px",
    marginBottom: 10,
  },
  rowCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    padding: "14px 16px",
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    marginBottom: 12,
  },
  rowTitle: {
    fontWeight: 700,
    marginBottom: 4,
  },
  rowSub: {
    color: "#64748b",
    fontSize: 14,
  },
  rowRight: {
    textAlign: "right",
    minWidth: 140,
    fontWeight: 600,
  },
  smallMuted: {
    color: "#64748b",
    fontSize: 13,
    marginTop: 4,
  },
  emptyText: {
    color: "#64748b",
    padding: "12px 0",
  },
  formGrid: {
    display: "grid",
    gap: 12,
  },
  input: {
    border: "1px solid #cbd5e1",
    borderRadius: 12,
    padding: "12px 14px",
    fontSize: 14,
    outline: "none",
    background: "#ffffff",
  },
  buttonRow: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
};
