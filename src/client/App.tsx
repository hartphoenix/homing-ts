import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { buildAgentSetupPrompt } from "./agentSetup";
import {
  ApiError,
  api,
  type Comment,
  clearCsrf,
  type InvitationDetails,
  type Lead,
  login,
  type Me,
  type Profile,
  type Project,
  registerInvitation,
  type SourcePlanReview,
} from "./api";
import { detectedTimezone, timezoneLabel, timezoneOptions } from "./timezones";

type AgentTokenSummary = {
  id: string;
  name: string;
  prefix?: string;
  created_at?: string | null;
  expires_at: string | null;
  last_used_at?: string | null;
  project_ids?: string[];
  revoked_at: string | null;
  scopes?: string[];
};

const backgroundOptions = [
  {
    id: "interior-staircase",
    label: "Staircase",
    src: "/backgrounds/interior-staircase.jpg",
  },
  {
    id: "interior-brownstone",
    label: "Brownstone interior",
    src: "/backgrounds/interior-brownstone.jpg",
  },
  {
    id: "exterior-golden-stoop",
    label: "Golden stoop",
    src: "/backgrounds/exterior-golden-stoop.jpg",
  },
  {
    id: "exterior-leafy-block",
    label: "Leafy block",
    src: "/backgrounds/exterior-leafy-block.jpg",
  },
] as const;

type BackgroundId = (typeof backgroundOptions)[number]["id"];

function storedBackground(): BackgroundId | null {
  const stored = window.localStorage.getItem("homing-background");
  return backgroundOptions.some(({ id }) => id === stored) ? (stored as BackgroundId) : null;
}

function BackgroundPicker({ defaultBackground }: { defaultBackground: BackgroundId }) {
  const [selected, setSelected] = useState<BackgroundId | null>(storedBackground);
  const active = selected ?? defaultBackground;

  useEffect(() => {
    const option = backgroundOptions.find(({ id }) => id === active);
    if (!option) return;
    document.documentElement.style.setProperty("--site-background-image", `url("${option.src}")`);
    document.documentElement.dataset.background = option.id;
  }, [active]);

  if (!import.meta.env.DEV) return null;

  return (
    <fieldset className="background-picker">
      <legend>Background</legend>
      {backgroundOptions.map((option) => (
        <label key={option.id} title={option.label}>
          <input
            checked={active === option.id}
            name="site-background"
            onChange={() => {
              setSelected(option.id);
              window.localStorage.setItem("homing-background", option.id);
            }}
            type="radio"
          />
          <span
            aria-hidden="true"
            className="background-picker-swatch"
            style={{ backgroundImage: `url("${option.src}")` }}
          />
          <span className="sr-only">{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function TokenDate({ value, empty }: { value: string | null | undefined; empty: string }) {
  if (!value) return <>{empty}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{empty}</>;
  return <time dateTime={value}>{date.toLocaleString()}</time>;
}

function daysOnMarket(listedAt: string | null | undefined): string {
  if (!listedAt) return "Unknown";
  const listed = new Date(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(listed.getTime())) return "Unknown";
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.max(0, Math.floor((todayUtc - listed.getTime()) / 86_400_000));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

function compactDaysOnMarket(listedAt: string | null | undefined): string {
  return daysOnMarket(listedAt).replace(/ days?$/, "d");
}

function listPrice(price: string): string {
  return price.replace(/\s*\/\s*(?:month|mo\.?)\s*$/i, "");
}

function Message({ error }: { error: unknown }) {
  if (!error) return null;
  const text =
    error instanceof ApiError && error.code === "final_owner"
      ? "A project must retain at least one owner. Transfer ownership before changing this role."
      : error instanceof ApiError && error.code === "self_removal"
        ? "Transfer ownership before removing yourself from this search."
        : error instanceof Error
          ? error.message
          : "The request could not be completed.";
  return (
    <p className="message error" role="alert">
      {text}
    </p>
  );
}

function Loading() {
  return (
    <main className="center">
      <p className="quiet">Loading Homing…</p>
    </main>
  );
}

function LoginPage({
  heading = "Sign in",
  onAuthenticated,
}: {
  heading?: string;
  onAuthenticated?: () => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: async () => {
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      onAuthenticated?.();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };
  return (
    <main className="login-page">
      <section className="login-intro">
        <Link className="wordmark" to="/">
          Homing
        </Link>
        <h1>Find the next place together.</h1>
      </section>
      <form className="panel login-form" onSubmit={submit}>
        <h2>{heading}</h2>
        <label>
          Email
          <input
            autoComplete="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <Message error={mutation.error} />
        <button className="button" disabled={mutation.isPending} type="submit">
          {mutation.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function InvitationPage({ authenticated = false }: { authenticated?: boolean }) {
  const location = useLocation();
  const { token: routeToken } = useParams();
  const token = routeToken || location.pathname.split("/")[2] || "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const details = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api<InvitationDetails>(`/invitations/${encodeURIComponent(token)}/accept`),
    enabled: Boolean(token),
    retry: false,
  });
  useEffect(() => {
    if (details.data) setEmail(details.data.email);
  }, [details.data]);
  const accept = useMutation({
    mutationFn: () =>
      api<{ project_id: string }>(`/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        mutation: true,
      }),
    onSuccess: async ({ project_id }) => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate(`/projects/${project_id}`);
    },
  });
  const register = useMutation({
    mutationFn: () => registerInvitation(token, { email, display_name: displayName, password }),
    onSuccess: async ({ project_id }) => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate(`/projects/${project_id}`);
    },
  });

  if (details.isLoading) return <Loading />;
  return (
    <main className="login-page invitation-page">
      <section className="login-intro">
        <Link className="wordmark" to="/">
          Homing
        </Link>
        <h1>Join a shared search.</h1>
      </section>
      <section className="panel invitation-card">
        <Message error={details.error} />
        {details.data && (
          <>
            <h2>{details.data.project.name}</h2>
            <p>
              {details.data.inviter_name || "A collaborator"} invited{" "}
              <strong>{details.data.email}</strong> as a {details.data.role}.
            </p>
            {authenticated ? (
              <>
                <p>Accept this invitation with the signed-in account.</p>
                <Message error={accept.error} />
                <button
                  className="button"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate()}
                  type="button"
                >
                  {accept.isPending ? "Accepting…" : "Accept invitation"}
                </button>
              </>
            ) : (
              <>
                <p>
                  Already have an account?{" "}
                  <Link
                    to={`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`}
                  >
                    Sign in to accept this invitation
                  </Link>
                  .
                </p>
                <form
                  className="invitation-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    register.mutate();
                  }}
                >
                  <label>
                    Invited email (cannot be changed)
                    <input
                      aria-label="Invited email"
                      autoComplete="email"
                      readOnly
                      required
                      type="email"
                      value={email}
                    />
                  </label>
                  <p className="quiet small">
                    This invitation is bound to this email address. Sign in with it to join.
                  </p>
                  <label>
                    Display name
                    <input
                      autoComplete="name"
                      onChange={(event) => setDisplayName(event.target.value)}
                      required
                      value={displayName}
                    />
                  </label>
                  <label>
                    Password
                    <input
                      autoComplete="new-password"
                      minLength={12}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      type="password"
                      value={password}
                    />
                  </label>
                  <p className="quiet small">
                    Use at least 12 characters. This invitation can only be used once.
                  </p>
                  <Message error={register.error} />
                  <button className="button" disabled={register.isPending} type="submit">
                    {register.isPending ? "Creating account…" : "Create account and join"}
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function PairingPage() {
  const { code: routeCode } = useParams();
  const [searchParams] = useSearchParams();
  const code = (routeCode || searchParams.get("code") || "").trim().toUpperCase();
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);
  const request = useQuery({
    queryKey: ["agent-link", code],
    queryFn: () =>
      api<{
        user_code: string;
        agent_label: string;
        environment_note: string;
        requested_cadence_minutes: number | null;
        expires_at: string;
      }>(`/auth/agent-links/${encodeURIComponent(code)}`),
    enabled: code.length > 0,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (action: "approve" | "deny") =>
      api<{ status: "approved" | "denied" }>(`/auth/agent-links/${encodeURIComponent(code)}`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ action }),
      }),
    onSuccess: ({ status }) => setDecision(status),
  });
  return (
    <main className="login-page pairing-page">
      <section className="login-intro">
        <Link className="wordmark" to="/">
          Homing
        </Link>
        <h1>Connect an agent safely.</h1>
      </section>
      <section className="panel pairing-card">
        {!code && (
          <Message error={new Error("Enter the six-character pairing code from your agent.")} />
        )}
        {request.isLoading && <p className="quiet">Checking pairing request…</p>}
        <Message error={request.error ?? decide.error} />
        {request.data && !decision && (
          <>
            <h2>Connect {request.data.agent_label}?</h2>
            <p>
              {request.data.environment_note ||
                "This agent is requesting access to your Homing account."}
            </p>
            {request.data.requested_cadence_minutes && (
              <p className="quiet small">
                Expected check-in: every {request.data.requested_cadence_minutes} minutes.
              </p>
            )}
            <p className="quiet small">Code: {request.data.user_code}</p>
            <div className="pairing-actions">
              <button
                className="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate("approve")}
                type="button"
              >
                {decide.isPending ? "Saving…" : "Approve agent"}
              </button>
              <button
                className="button"
                disabled={decide.isPending}
                onClick={() => decide.mutate("deny")}
                type="button"
              >
                Deny
              </button>
            </div>
          </>
        )}
        {decision && (
          <p className="message" role="status">
            Pairing {decision}. You can close this page.
          </p>
        )}
      </section>
    </main>
  );
}

function SourcePlanBanner() {
  const [showRepair, setShowRepair] = useState(false);
  const reviews = useQuery({
    queryKey: ["source-plan-reviews"],
    queryFn: () =>
      api<{ items: SourcePlanReview[] }>("/me/source-plan-reviews?status=open", {
        suppressSessionExpired: true,
      }),
    retry: false,
  });
  const repair = useQuery({
    queryKey: ["source-plan-repair"],
    queryFn: () =>
      api<{ open_review_count: number; prompt: string }>("/me/source-plan-repair", {
        suppressSessionExpired: true,
      }),
    enabled: showRepair,
    retry: false,
  });
  const copyRepair = async () => {
    if (!repair.data?.prompt) return;
    try {
      await navigator.clipboard.writeText(repair.data.prompt);
    } catch {
      setShowRepair(true);
    }
  };
  const items = reviews.data?.items ?? [];
  if (items.length === 0 && !reviews.error) return null;
  return (
    <section aria-label="Source plan review" className="source-plan-banner panel">
      <Message error={reviews.error} />
      {items.length > 0 && (
        <>
          <div>
            <h2>
              {items.length} assistant {items.length === 1 ? "needs" : "need"} to review source
              plans
            </h2>
            <p className="quiet">
              The installed agent should compare its source plan with the current search brief.
            </p>
          </div>
          <div className="source-plan-actions">
            <button className="button" onClick={() => setShowRepair((open) => !open)} type="button">
              {showRepair ? "Hide guidance" : "See what it says"}
            </button>
          </div>
          {showRepair && (
            <div className="source-plan-repair">
              <Message error={repair.error} />
              {repair.isLoading && <p className="quiet small">Loading repair guidance…</p>}
              {repair.data && (
                <>
                  <label className="sr-only" htmlFor="source-plan-repair-prompt">
                    Server-authored repair prompt
                  </label>
                  <textarea
                    id="source-plan-repair-prompt"
                    aria-label="Server-authored repair prompt"
                    readOnly
                    rows={8}
                    value={repair.data.prompt}
                  />
                  <button className="button" onClick={copyRepair} type="button">
                    Copy repair guidance
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const projectLeadIndex = /^\/projects\/[^/]+\/?$/.test(location.pathname);
  const currentView = searchParams.get("view") === "list" ? "list" : "cards";
  const logout = useMutation({
    mutationFn: () => api<void>("/session", { method: "DELETE", mutation: true }),
    onSuccess: async () => {
      clearCsrf();
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="wordmark" to="/">
          Homing
        </Link>
        <nav aria-label="Primary" className="desktop-nav">
          <NavLink end to="/">
            Searches
          </NavLink>
          <NavLink to="/agent-setup">Agent setup</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="account-menu">
          <Link className="profile-link" to="/settings">
            {me.profile?.display_name || me.user.email}
          </Link>
          <span aria-hidden="true">·</span>
          <button className="plain-button" onClick={() => logout.mutate()} type="button">
            Sign out
          </button>
        </div>
        <div className="mobile-menu">
          <button
            aria-controls="mobile-navigation"
            aria-expanded={mobileMenuOpen}
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            className="mobile-menu-trigger"
            onClick={() => setMobileMenuOpen((open) => !open)}
            type="button"
          >
            <span aria-hidden="true">☰</span>
          </button>
          {mobileMenuOpen && (
            <nav
              aria-label="Mobile navigation"
              className="mobile-menu-panel"
              id="mobile-navigation"
            >
              <NavLink end onClick={() => setMobileMenuOpen(false)} to="/">
                Searches
              </NavLink>
              <NavLink onClick={() => setMobileMenuOpen(false)} to="/agent-setup">
                Agent setup
              </NavLink>
              <NavLink onClick={() => setMobileMenuOpen(false)} to="/settings">
                Settings
              </NavLink>
              {projectLeadIndex && (
                <button
                  className="mobile-view-action"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    currentView === "cards" ? next.set("view", "list") : next.delete("view");
                    next.delete("cursor");
                    setSearchParams(next);
                    setMobileMenuOpen(false);
                  }}
                  type="button"
                >
                  View as {currentView === "cards" ? "list" : "cards"}
                </button>
              )}
              <button
                className="mobile-sign-out"
                onClick={() => {
                  setMobileMenuOpen(false);
                  logout.mutate();
                }}
                type="button"
              >
                Sign out
              </button>
            </nav>
          )}
        </div>
      </header>
      <SourcePlanBanner />
      {children}
    </div>
  );
}

function Dashboard() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ items: Project[] }>("/me/projects"),
  });
  const create = useMutation({
    mutationFn: () =>
      api<Project>("/projects", {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ name, description, prompt, criteria: {} }),
      }),
    onSuccess: async () => {
      setName("");
      setDescription("");
      setPrompt("");
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return (
    <main className="page">
      <header className="page-heading">
        <h1>Your shared searches</h1>
      </header>
      <Message error={projects.error} />
      <section className="project-grid" aria-live="polite">
        {projects.data?.items.map((project) => (
          <ProjectCard key={project.id} project={project} />
        ))}
        {projects.data?.items.length === 0 && (
          <div className="empty">
            <h2>No searches yet</h2>
            <p>Start one shared brief, then connect the people and agents helping with it.</p>
          </div>
        )}
      </section>
      {creating && (
        <form
          className="panel create-project"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Search name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
              placeholder="September housing"
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={10000}
              rows={3}
              placeholder="A short summary shown on the search card"
            />
          </label>
          <label>
            Initial search brief
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={30000}
              required
              rows={6}
              placeholder="What should the search find?"
            />
          </label>
          <Message error={create.error} />
          <button className="button" disabled={create.isPending} type="submit">
            Create search
          </button>
        </form>
      )}
      <button
        className="button dashboard-action"
        onClick={() => setCreating((value) => !value)}
        type="button"
      >
        {creating ? "Cancel" : "New search"}
      </button>
    </main>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const count = useQuery({
    queryKey: ["dashboard-lead-count", project.id],
    queryFn: () => api<{ total: number }>(`/projects/${project.id}/leads?limit=1`),
  });
  return (
    <Link className="project-card" to={`/projects/${project.id}`}>
      <div>
        <span className="status-dot" />
        <span className="quiet small">{project.role ?? "Member"}</span>
      </div>
      <h2>{project.name}</h2>
      <p>{project.description || "No description yet."}</p>
      <footer>
        <span>
          {count.data
            ? `${count.data.total} ${count.data.total === 1 ? "lead" : "leads"}`
            : "Leads"}
        </span>
        <span>Open search →</span>
      </footer>
    </Link>
  );
}

function LeadIndex({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const query = searchParams.get("q") ?? "";
  const status = searchParams.get("status") === "trash" ? "trash" : "active";
  const view = searchParams.get("view") === "list" ? "list" : "cards";
  const sort = searchParams.get("sort") ?? "updated";
  const cursor = searchParams.get("cursor") ?? "";
  const leads = useQuery({
    queryKey: ["leads", projectId, query, status, sort, cursor],
    queryFn: () => {
      const params = new URLSearchParams({
        q: query,
        status,
        sort,
        limit: "50",
      });
      if (cursor) params.set("cursor", cursor);
      const path =
        status === "trash"
          ? `/projects/${projectId}/trash?${params}`
          : `/projects/${projectId}/leads?${params}`;
      return api<{ items: Lead[]; total: number; next_cursor?: string | null }>(path);
    },
  });
  const batch = useMutation({
    mutationFn: (action: "trash" | "restore" | "interested" | "uninterested") =>
      api(`/projects/${projectId}/leads/batch`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ lead_ids: selected, action }),
      }),
    onSuccess: async () => {
      setSelected([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["leads", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["lead-count", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-lead-count", projectId] }),
      ]);
    },
  });
  const setInterest = useMutation({
    mutationFn: ({ leadId, interested }: { leadId: string; interested: boolean }) =>
      api(`/projects/${projectId}/leads/${leadId}/interest`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ interested }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["leads", projectId] });
    },
  });
  const toggleSelected = (leadId: string) =>
    setSelected((current) =>
      current.includes(leadId) ? current.filter((id) => id !== leadId) : [...current, leadId],
    );
  const setSort = (column: "price" | "days") => {
    const next = new URLSearchParams(searchParams);
    const current = searchParams.get("sort") ?? "";
    next.set("sort", current === `${column}_asc` ? `${column}_desc` : `${column}_asc`);
    next.delete("cursor");
    setSearchParams(next);
  };
  const sortDirection = (column: "price" | "days") =>
    sort === `${column}_asc` ? "ascending" : sort === `${column}_desc` ? "descending" : "none";
  const allVisibleSelected = Boolean(
    leads.data?.items.length && leads.data.items.every((lead) => selected.includes(lead.id)),
  );
  return (
    <>
      <div className="lead-tools">
        <input
          aria-label="Search leads"
          placeholder="Search title, location, or description"
          value={query}
          onChange={(event) => {
            const next = new URLSearchParams(searchParams);
            event.target.value ? next.set("q", event.target.value) : next.delete("q");
            next.delete("cursor");
            setSelected([]);
            setSearchParams(next, { replace: true });
          }}
        />
        <select
          aria-label="Lead status"
          value={status}
          onChange={(event) => {
            const next = new URLSearchParams(searchParams);
            event.target.value === "trash" ? next.set("status", "trash") : next.delete("status");
            next.delete("cursor");
            setSelected([]);
            setSearchParams(next);
          }}
        >
          <option value="active">Active</option>
          <option value="trash">Trash</option>
        </select>
      </div>
      {selected.length > 0 && (
        <div className="batch-bar" aria-label="Batch actions" role="toolbar">
          <strong>{selected.length} selected</strong>
          {status === "active" ? (
            <>
              <button
                className="plain-button"
                onClick={() => batch.mutate("interested")}
                type="button"
              >
                Interested
              </button>
              <button
                className="plain-button"
                onClick={() => batch.mutate("uninterested")}
                type="button"
              >
                Not interested
              </button>
              <button className="plain-button" onClick={() => batch.mutate("trash")} type="button">
                Move to trash
              </button>
            </>
          ) : (
            <button className="plain-button" onClick={() => batch.mutate("restore")} type="button">
              Restore
            </button>
          )}
        </div>
      )}
      <Message error={leads.error} />
      <Message error={batch.error} />
      <Message error={setInterest.error} />
      {view === "cards" ? (
        <section className="lead-list" aria-label="Lead cards">
          {leads.data?.items.map((lead) => (
            <article className="lead-card" key={lead.id}>
              <Link
                className="lead-card-hit"
                aria-label={lead.title}
                to={`/projects/${projectId}/leads/${lead.id}${status === "trash" ? "?from=trash" : ""}`}
              />
              <div className="lead-card-top">
                <span className="source">{lead.source}</span>
                <div className="lead-card-pricing">
                  <span className="price">{lead.price_display || "Price unknown"}</span>
                  <span className="quiet small">{daysOnMarket(lead.listed_at)}</span>
                </div>
              </div>
              <h2>{lead.title}</h2>
              <p>{[lead.location, lead.availability].filter(Boolean).join(" · ")}</p>
              <p className="clamp">{lead.summary}</p>
              <footer>
                <span className="lead-card-engagement">
                  <span aria-hidden="true">
                    {lead.interest_count ? `${lead.interest_count} ♥` : "♡"}
                  </span>
                  <span className="sr-only">{lead.interest_count ?? 0} interested</span>
                  {Boolean(lead.comment_count) && (
                    <>
                      <span aria-hidden="true">|</span>
                      <span>
                        {lead.comment_count} {lead.comment_count === 1 ? "comment" : "comments"}
                      </span>
                    </>
                  )}
                </span>
                <label className="lead-select">
                  <span className="sr-only">Select {lead.title}</span>
                  <input
                    checked={selected.includes(lead.id)}
                    onChange={() => toggleSelected(lead.id)}
                    type="checkbox"
                  />
                </label>
              </footer>
            </article>
          ))}
          {leads.data?.items.length === 0 && (
            <div className="empty">
              <h2>{status === "trash" ? "Trash is empty" : "No leads here"}</h2>
              <p>
                {status === "trash"
                  ? "Moved listings will appear here until they are restored."
                  : "The shared search is ready for its next result."}
              </p>
            </div>
          )}
        </section>
      ) : (
        <div className="lead-table-wrap">
          <table className="lead-table">
            <thead>
              <tr>
                <th className="check-column">
                  <input
                    aria-label="Select all visible leads"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelected(
                        allVisibleSelected ? [] : (leads.data?.items.map((lead) => lead.id) ?? []),
                      )
                    }
                    type="checkbox"
                  />
                </th>
                <th>Listing</th>
                <th aria-sort={sortDirection("price")}>
                  <button onClick={() => setSort("price")} type="button">
                    Price
                  </button>
                </th>
                <th aria-sort={sortDirection("days")}>
                  <button onClick={() => setSort("days")} type="button">
                    On market
                  </button>
                </th>
                <th className="interest-column">
                  <span aria-hidden="true">♥</span>
                  <span className="sr-only">Interest</span>
                </th>
                <th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {leads.data?.items.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <input
                      aria-label={`Select ${lead.title}`}
                      checked={selected.includes(lead.id)}
                      onChange={() => toggleSelected(lead.id)}
                      type="checkbox"
                    />
                  </td>
                  <td>
                    <Link
                      to={`/projects/${projectId}/leads/${lead.id}${status === "trash" ? "?from=trash" : ""}`}
                    >
                      <strong>{lead.title}</strong>
                      <span className="lead-location">{lead.location || "Location unknown"}</span>
                    </Link>
                  </td>
                  <td>{lead.price_display ? listPrice(lead.price_display) : "Unknown"}</td>
                  <td>{compactDaysOnMarket(lead.listed_at)}</td>
                  <td>
                    {status === "trash" ? (
                      <span className="quiet small" title="Interest unavailable in trash">
                        —
                      </span>
                    ) : (
                      <button
                        aria-label={`${(lead.interested ?? lead.is_interested) ? "Remove interest from" : "Mark interested in"} ${lead.title}`}
                        aria-pressed={Boolean(lead.interested ?? lead.is_interested)}
                        className="interest-toggle"
                        disabled={setInterest.isPending}
                        onClick={() =>
                          setInterest.mutate({
                            leadId: lead.id,
                            interested: !(lead.interested ?? lead.is_interested),
                          })
                        }
                        type="button"
                      >
                        {lead.interest_count
                          ? `${lead.interest_count} ${(lead.interested ?? lead.is_interested) ? "♥" : "♡"}`
                          : "♡"}
                      </button>
                    )}
                  </td>
                  <td>{lead.comment_count || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leads.data?.items.length === 0 && (
            <div className="empty">
              <h2>{status === "trash" ? "Trash is empty" : "No leads here"}</h2>
              <p>
                {status === "trash"
                  ? "Moved listings will appear here until they are restored."
                  : "The shared search is ready for its next result."}
              </p>
            </div>
          )}
        </div>
      )}
      {leads.data?.next_cursor && (
        <nav aria-label="Lead pages" className="lead-pagination">
          <span className="quiet small">Showing up to {leads.data.items.length} leads</span>
          <button
            className="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.set("cursor", leads.data?.next_cursor ?? "");
              setSelected([]);
              setSearchParams(next);
            }}
            type="button"
          >
            Next page
          </button>
        </nav>
      )}
    </>
  );
}

function ProjectPage({ currentUserId }: { currentUserId: number }) {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const activeLeadCount = useQuery({
    queryKey: ["lead-count", projectId],
    queryFn: () => api<{ total: number }>(`/projects/${projectId}/leads?limit=1`),
  });
  if (project.isLoading) return <Loading />;
  if (project.error || !project.data) {
    return (
      <main className="page project-page">
        <Message error={project.error ?? new Error("The search could not be loaded.")} />
      </main>
    );
  }
  return (
    <main className="page project-page">
      <header className="page-heading">
        <h1>{project.data.name}</h1>
      </header>
      <div className="project-tabs-row">
        <nav className="tabs" aria-label="Project">
          <NavLink end to={`/projects/${projectId}`}>
            Leads{activeLeadCount.data?.total ? ` (${activeLeadCount.data.total})` : ""}
          </NavLink>
          <NavLink to={`/projects/${projectId}/brief`}>Brief</NavLink>
          <NavLink to={`/projects/${projectId}/members`}>People</NavLink>
        </nav>
        {location.pathname.replace(/\/$/, "") === `/projects/${projectId}` && (
          <fieldset className="view-toggle">
            <legend className="sr-only">View mode</legend>
            {(["cards", "list"] as const).map((mode) => (
              <button
                className={(searchParams.get("view") ?? "cards") === mode ? "active" : ""}
                key={mode}
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  mode === "list" ? next.set("view", "list") : next.delete("view");
                  next.delete("cursor");
                  setSearchParams(next);
                }}
                type="button"
              >
                {mode === "cards" ? "Cards" : "List"}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      <Routes>
        <Route
          index
          element={<LeadIndex key={searchParams.get("view") ?? "cards"} projectId={projectId} />}
        />
        <Route
          path="brief"
          element={project.data ? <BriefEditor project={project.data} /> : null}
        />
        <Route
          path="members"
          element={
            <Members
              canManage={project.data?.role === "owner"}
              currentUserId={currentUserId}
              projectId={projectId}
            />
          }
        />
      </Routes>
    </main>
  );
}

function BriefEditor({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(project.description);
  const [prompt, setPrompt] = useState(project.prompt ?? project.current_prompt ?? "");
  const projectId = useRef(project.id);
  useEffect(() => {
    if (projectId.current === project.id) return;
    projectId.current = project.id;
    setDescription(project.description);
    setPrompt(project.prompt ?? project.current_prompt ?? "");
  }, [project]);
  const descriptionMutation = useMutation({
    mutationFn: () =>
      api<Project>(`/projects/${project.id}`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ description }),
      }),
    onSuccess: async (updated) => {
      setDescription(updated.description);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
  const mutation = useMutation({
    mutationFn: () =>
      api<{ prompt?: string }>(`/projects/${project.id}/prompt`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({
          prompt,
          criteria: project.criteria ?? {},
          expected_revision: project.prompt_revision,
        }),
      }),
    onSuccess: async (updated) => {
      if (updated.prompt !== undefined) setPrompt(updated.prompt);
      await queryClient.invalidateQueries({ queryKey: ["project", project.id] });
    },
  });
  return (
    <div className="brief-stack">
      <form
        className="panel editor"
        onSubmit={(event) => {
          event.preventDefault();
          descriptionMutation.mutate();
        }}
      >
        <h2>Search description</h2>
        <label>
          Description shown on the search card
          <textarea
            maxLength={20000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
            rows={3}
            value={description}
          />
        </label>
        <Message error={descriptionMutation.error} />
        <button className="button" disabled={descriptionMutation.isPending} type="submit">
          Save description
        </button>
      </form>
      <form
        className="panel editor"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div>
          <h2>What should the search find?</h2>
        </div>
        <label>
          Instructions
          <textarea
            rows={14}
            maxLength={30000}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
          />
        </label>
        <Message error={mutation.error} />
        {mutation.error instanceof ApiError && mutation.error.status === 409 && (
          <p className="message">
            Your draft is still here. Reload the current brief in another tab before deciding what
            to keep.
          </p>
        )}
        <button className="button" disabled={mutation.isPending} type="submit">
          Save new revision
        </button>
      </form>
    </div>
  );
}

type ProjectMember = {
  user_id: number;
  display_name: string;
  email: string;
  role: "owner" | "editor" | "viewer";
};

type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  status: "pending";
  expires_at: string;
};

type CreatedInvitation = {
  id: string;
  role: string;
  expires_at: string;
  invite_url: string;
};

type MembersData = {
  items: ProjectMember[];
  pending_invitations?: PendingInvitation[];
};

function Members({
  projectId,
  canManage,
  currentUserId,
}: {
  projectId: string;
  canManage: boolean;
  currentUserId: number;
}) {
  const queryClient = useQueryClient();
  const [isInviting, setIsInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteCopyStatus, setInviteCopyStatus] = useState("");
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api<MembersData>(`/projects/${projectId}/members`),
  });
  const invite = useMutation({
    mutationFn: (invitedEmail: string) =>
      api<CreatedInvitation>(`/projects/${projectId}/invitations`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ email: invitedEmail, role: "viewer" }),
      }),
    onSuccess: (invitation, invitedEmail) => {
      setInviteUrl(new URL(invitation.invite_url, window.location.origin).toString());
      setInviteCopyStatus("");
      queryClient.setQueryData<MembersData>(["members", projectId], (current) => ({
        items: current?.items ?? [],
        pending_invitations: [
          ...(current?.pending_invitations ?? []),
          {
            id: invitation.id,
            email: invitedEmail,
            role: invitation.role,
            status: "pending",
            expires_at: invitation.expires_at,
          },
        ],
      }));
      setEmail("");
      setIsInviting(false);
    },
  });
  const removeMember = useMutation({
    mutationFn: (userId: number) =>
      api<void>(`/projects/${projectId}/members`, {
        method: "DELETE",
        mutation: true,
        body: JSON.stringify({ user_id: userId }),
      }),
    onSuccess: (_, userId) => {
      queryClient.setQueryData<MembersData>(["members", projectId], (current) => ({
        ...current,
        items: current?.items.filter((member) => member.user_id !== userId) ?? [],
      }));
    },
  });
  const cancelInvitation = useMutation({
    mutationFn: (invitationId: string) =>
      api<void>(`/projects/${projectId}/invitations`, {
        method: "DELETE",
        mutation: true,
        body: JSON.stringify({ invitation_id: invitationId }),
      }),
    onSuccess: (_, invitationId) => {
      queryClient.setQueryData<MembersData>(["members", projectId], (current) => ({
        items: current?.items ?? [],
        pending_invitations: (current?.pending_invitations ?? []).filter(
          (invitation) => invitation.id !== invitationId,
        ),
      }));
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: ProjectMember["role"] }) =>
      api<ProjectMember>(`/projects/${projectId}/members/${userId}`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ role }),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<MembersData>(["members", projectId], (current) => ({
        items:
          current?.items.map((member) => (member.user_id === updated.user_id ? updated : member)) ??
          [],
        pending_invitations: current?.pending_invitations ?? [],
      }));
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const pendingInvitations = members.data?.pending_invitations ?? [];

  return (
    <section className="panel">
      <h2>Search party</h2>
      <Message error={members.error} />
      <Message
        error={invite.error ?? removeMember.error ?? cancelInvitation.error ?? changeRole.error}
      />
      <div className="member-list">
        {members.data?.items.map((member) => (
          <div className="member-row" key={member.user_id}>
            <span className="avatar">{member.display_name?.slice(0, 1) || "?"}</span>
            <div className="member-identity">
              <strong>{member.display_name}</strong>
              <p className="quiet small">{member.email}</p>
            </div>
            {canManage ? (
              <label>
                <span className="sr-only">Role for {member.display_name}</span>
                <select
                  aria-label={`Role for ${member.display_name}`}
                  disabled={changeRole.isPending}
                  onChange={(event) =>
                    changeRole.mutate({
                      userId: member.user_id,
                      role: event.target.value as ProjectMember["role"],
                    })
                  }
                  value={member.role}
                >
                  <option value="owner">Owner</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
            ) : (
              <span className="pill">{member.role}</span>
            )}
            {canManage && member.user_id !== currentUserId && (
              <button
                className="button member-remove"
                disabled={removeMember.isPending}
                onClick={() => removeMember.mutate(member.user_id)}
                type="button"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {pendingInvitations.map((invitation) => (
          <div className="member-row" key={invitation.id}>
            <span className="avatar pending-avatar">
              {invitation.email.slice(0, 1).toUpperCase()}
            </span>
            <div className="member-identity">
              <strong>{invitation.email}</strong>
              <p className="quiet small">Invitation awaiting response</p>
            </div>
            <span className="pill">Pending</span>
            {canManage && (
              <button
                className="button member-remove"
                disabled={cancelInvitation.isPending}
                onClick={() => cancelInvitation.mutate(invitation.id)}
                type="button"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {isInviting && (
          <form
            className="member-row invite-row"
            onSubmit={(event) => {
              event.preventDefault();
              invite.mutate(email.trim());
            }}
          >
            <label className="sr-only" htmlFor="invite-email">
              Email address
            </label>
            <input
              autoComplete="email"
              id="invite-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
              required
              type="email"
              value={email}
            />
            <button className="button" disabled={invite.isPending} type="submit">
              {invite.isPending ? "Creating link…" : "Create invite link"}
            </button>
          </form>
        )}
      </div>
      {inviteUrl && (
        <div className="one-time-key invitation-link" role="status">
          <strong>Copy this one-time invitation link now.</strong>
          <label>
            Invitation link
            <input aria-label="Invitation link" readOnly value={inviteUrl} />
          </label>
          <button
            className="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(inviteUrl);
                setInviteCopyStatus("Invitation link copied.");
              } catch {
                setInviteCopyStatus("Copy failed. Select the link manually.");
              }
            }}
            type="button"
          >
            Copy invitation link
          </button>
          <span className="copy-status" role="status">
            {inviteCopyStatus}
          </span>
        </div>
      )}
      {!isInviting && (
        <button
          className="button invite-trigger"
          onClick={() => {
            setInviteUrl("");
            setInviteCopyStatus("");
            setIsInviting(true);
          }}
          type="button"
        >
          Invite
        </button>
      )}
    </section>
  );
}

function LeadPage() {
  const { projectId = "", leadId = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [leadSearchParams] = useSearchParams();
  const [comment, setComment] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftListedAt, setDraftListedAt] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const leadQueryKey = ["lead", projectId, leadId, leadSearchParams.get("from")] as const;
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const lead = useQuery({
    queryKey: leadQueryKey,
    queryFn: () => api<Lead>(`/projects/${projectId}/leads/${leadId}`),
  });
  const leadIsTrashed = lead.data?.status === "trashed" || leadSearchParams.get("from") === "trash";
  useEffect(() => {
    if (!lead.data || isEditing) return;
    setDraftTitle(lead.data.title);
    setDraftPrice(lead.data.price_display);
    setDraftListedAt(lead.data.listed_at ?? "");
    setDraftSummary(lead.data.summary);
  }, [lead.data, isEditing]);
  const comments = useQuery({
    queryKey: ["comments", projectId, leadId],
    queryFn: () => api<{ items: Comment[] }>(`/projects/${projectId}/leads/${leadId}/comments`),
    enabled: Boolean(lead.data && !leadIsTrashed),
  });
  const addComment = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/leads/${leadId}/comments`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ body: comment }),
      }),
    onSuccess: async () => {
      setComment("");
      await queryClient.invalidateQueries({ queryKey: ["comments", projectId, leadId] });
    },
  });
  const updateLead = useMutation({
    mutationFn: () => {
      if (!lead.data) throw new Error("The lead is not loaded.");
      return api<Lead>(`/projects/${projectId}/leads/${leadId}`, {
        method: "PATCH",
        mutation: true,
        headers: { "If-Match": `"${lead.data.revision}"` },
        body: JSON.stringify({
          title: draftTitle.trim(),
          price_display: draftPrice.trim(),
          listed_at: draftListedAt || null,
          summary: draftSummary,
          expected_revision: lead.data.revision,
        }),
      });
    },
    onSuccess: async (updatedLead) => {
      queryClient.setQueryData(leadQueryKey, updatedLead);
      setIsEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["leads", projectId] });
    },
  });
  const setInterest = useMutation({
    mutationFn: (interested: boolean) =>
      api(`/projects/${projectId}/leads/${leadId}/interest`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ interested }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["lead", projectId, leadId] }),
        queryClient.invalidateQueries({ queryKey: ["leads", projectId] }),
      ]);
    },
  });
  const trashLead = useMutation({
    mutationFn: () => {
      if (!lead.data) throw new Error("The lead is not loaded.");
      return api<Lead>(`/projects/${projectId}/leads/${leadId}`, {
        method: "DELETE",
        mutation: true,
        headers: { "If-Match": `"${lead.data.revision}"` },
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["leads", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["lead-count", projectId] }),
      ]);
      navigate(`/projects/${projectId}`);
    },
  });
  const restoreLead = useMutation({
    mutationFn: () => {
      if (!lead.data) throw new Error("The lead is not loaded.");
      return api<Lead>(`/projects/${projectId}/trash/${leadId}/restore`, {
        method: "POST",
        mutation: true,
        headers: { "If-Match": `"${lead.data.revision}"` },
      });
    },
    onSuccess: async (updatedLead) => {
      queryClient.setQueryData(leadQueryKey, updatedLead);
      queryClient.setQueryData(["lead", projectId, leadId], updatedLead);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["lead", projectId, leadId] }),
        queryClient.invalidateQueries({ queryKey: ["leads", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["lead-count", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-lead-count", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["comments", projectId, leadId] }),
      ]);
      navigate(`/projects/${projectId}/leads/${leadId}`, { replace: true });
    },
  });
  return (
    <main className="page detail-page">
      <Link className="back" to={`/projects/${projectId}`}>
        ← All {project.data?.name ? `${project.data.name} ` : ""}leads
      </Link>
      <Message error={project.error} />
      <Message error={lead.error} />
      {lead.data && (
        <>
          <header className="detail-heading">
            {isEditing ? (
              <input
                aria-label="Title"
                className="detail-title-input"
                maxLength={500}
                onChange={(event) => setDraftTitle(event.target.value)}
                required
                value={draftTitle}
              />
            ) : (
              <h1>{lead.data.title}</h1>
            )}
            <div className="detail-market-data">
              {isEditing ? (
                <>
                  <input
                    aria-label="Price"
                    className="detail-price detail-price-input"
                    maxLength={200}
                    onChange={(event) => setDraftPrice(event.target.value)}
                    placeholder="Price unknown"
                    value={draftPrice}
                  />
                  <label className="listed-date-field">
                    Date listed
                    <input
                      aria-label="Date listed"
                      onChange={(event) => setDraftListedAt(event.target.value)}
                      type="date"
                      value={draftListedAt}
                    />
                  </label>
                </>
              ) : (
                <>
                  <strong className="detail-price">
                    {lead.data.price_display || "Price unknown"}
                  </strong>
                  <span className="detail-days">{daysOnMarket(lead.data.listed_at)} on market</span>
                </>
              )}
            </div>
            <a className="button" href={lead.data.url} target="_blank" rel="noreferrer">
              Open listing ↗
            </a>
          </header>
          <div className="detail-grid">
            <article className="panel prose lead-detail-card">
              <h2>What we know</h2>
              {isEditing ? (
                <textarea
                  aria-label="Description"
                  maxLength={30000}
                  onChange={(event) => setDraftSummary(event.target.value)}
                  rows={7}
                  value={draftSummary}
                />
              ) : (
                <p>{lead.data.summary || "No summary yet."}</p>
              )}
              <Message
                error={
                  updateLead.error ?? setInterest.error ?? trashLead.error ?? restoreLead.error
                }
              />
              {isEditing ? (
                <div className="lead-edit-actions">
                  <button className="button" onClick={() => setIsEditing(false)} type="button">
                    Cancel
                  </button>
                  <button
                    className="button"
                    disabled={updateLead.isPending || !draftTitle.trim()}
                    onClick={() => updateLead.mutate()}
                    type="button"
                  >
                    {updateLead.isPending ? "Saving…" : "Save lead"}
                  </button>
                </div>
              ) : (
                <div className="lead-detail-actions">
                  {!leadIsTrashed && (
                    <button
                      aria-label={lead.data.interested ? "Remove interest" : "Mark interested"}
                      className={`icon-button interest-button${lead.data.interested ? " active" : ""}`}
                      disabled={setInterest.isPending}
                      onClick={() => setInterest.mutate(!lead.data?.interested)}
                      title={lead.data.interested ? "Remove interest" : "Mark interested"}
                      type="button"
                    >
                      <span aria-hidden="true">{lead.data.interested ? "♥" : "♡"}</span>
                    </button>
                  )}
                  <button
                    aria-label={leadIsTrashed ? "Restore" : "Move to trash"}
                    className="icon-button"
                    disabled={trashLead.isPending || restoreLead.isPending}
                    onClick={() => (leadIsTrashed ? restoreLead.mutate() : trashLead.mutate())}
                    title={leadIsTrashed ? "Restore" : "Move to trash"}
                    type="button"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                  {!leadIsTrashed && (
                    <button
                      aria-label="Edit lead"
                      className="icon-button"
                      onClick={() => setIsEditing(true)}
                      title="Edit lead"
                      type="button"
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="m19 5-3-3L4 14l-1 5 5-1L20 6l-1-1Z" />
                        <path d="m14 4 4 4" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </article>
            {(lead.data.interested_users?.length ?? 0) > 0 && (
              <p className="interested-members">
                Interested: {lead.data.interested_users?.join(", ")}
              </p>
            )}
            <aside className="panel">
              <h2>Conversation</h2>
              {!leadIsTrashed && (
                <>
                  <Message error={comments.error} />
                  <div className="comments">
                    {comments.data?.items.map((item) => (
                      <div key={item.id}>
                        <span className="avatar">{String(item.author_id).slice(0, 1)}</span>
                        <p>
                          {item.body}
                          <small>{new Date(item.created_at).toLocaleString()}</small>
                        </p>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {leadIsTrashed ? (
                <p className="quiet small">Comments are unavailable while this lead is in trash.</p>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    addComment.mutate();
                  }}
                >
                  <label className="sr-only" htmlFor="comment">
                    Add a comment
                  </label>
                  <textarea
                    id="comment"
                    rows={3}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    maxLength={10000}
                    required
                    placeholder="Add a note for everyone…"
                  />
                  <Message error={addComment.error} />
                  <button className="button" disabled={addComment.isPending} type="submit">
                    Add comment
                  </button>
                </form>
              )}
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page">
      <header className="page-heading">
        <h1>{title}</h1>
      </header>
      <section className="panel prose">{children}</section>
    </main>
  );
}

function AgentSetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [previewActiveKey, setPreviewActiveKey] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [keyName, setKeyName] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [newAccessKey, setNewAccessKey] = useState("");
  const [newAccessKeyId, setNewAccessKeyId] = useState("");
  const tokens = useQuery({
    queryKey: ["agent-tokens"],
    queryFn: () => api<{ items: AgentTokenSummary[] }>("/auth/tokens"),
  });
  const activeTokens =
    tokens.data?.items.filter(
      (token) =>
        !token.revoked_at && (!token.expires_at || Date.parse(token.expires_at) > Date.now()),
    ) ?? [];
  const previewToken: AgentTokenSummary = {
    id: "preview-agent-token",
    name: "Example agent",
    prefix: "homing_preview",
    created_at: "2026-08-12T14:30:00Z",
    expires_at: "2026-11-10T14:30:00Z",
    last_used_at: "2026-08-22T16:05:00Z",
    revoked_at: null,
  };
  const hasActiveKey = previewActiveKey || (tokens.isSuccess && activeTokens.length > 0);
  const displayedActiveTokens =
    previewActiveKey && activeTokens.length === 0 ? [previewToken] : activeTokens;
  const showSetupPrompt =
    !previewActiveKey && (tokens.isError || (tokens.isSuccess && activeTokens.length === 0));
  const setupPrompt = buildAgentSetupPrompt(window.location.origin);
  const manualAgentScopes = [
    "profile:read",
    "projects:read",
    "prompts:read",
    "leads:read",
    "leads:write",
    "comments:read",
    "comments:write",
    "interest:read",
    "interest:write",
    "runs:write",
  ];
  const disconnectToken = useMutation({
    mutationFn: (tokenId: string) =>
      api<void>(`/auth/tokens/${tokenId}`, { method: "DELETE", mutation: true }),
    onSuccess: async (_, tokenId) => {
      if (tokenId === newAccessKeyId) {
        setNewAccessKey("");
        setNewAccessKeyId("");
      }
      await queryClient.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });
  const createToken = useMutation({
    mutationFn: () =>
      api<{
        id: string;
        token: string;
        scopes: string[];
        project_ids: string[];
        expires_at: string;
      }>("/auth/tokens", {
        method: "POST",
        mutation: true,
        body: JSON.stringify({
          name: keyName.trim(),
          scopes: manualAgentScopes,
        }),
      }),
    onSuccess: async (created) => {
      setKeyName("");
      setNewAccessKey(created.token);
      setNewAccessKeyId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });

  const copySetupPrompt = async () => {
    try {
      await navigator.clipboard.writeText(setupPrompt);
      setCopyStatus("Setup prompt copied.");
    } catch {
      setIsPromptOpen(true);
      setCopyStatus("Copy failed. Copy the revealed prompt manually.");
    }
  };

  const promptControls = (
    <div className="setup-prompt">
      <div className="setup-prompt-controls">
        <button className="button" type="button" onClick={copySetupPrompt}>
          Copy setup prompt
        </button>
        <button
          aria-controls="agent-setup-prompt"
          aria-expanded={isPromptOpen}
          aria-label={isPromptOpen ? "Hide setup prompt" : "Show setup prompt"}
          className="disclosure-button"
          onClick={() => setIsPromptOpen((isOpen) => !isOpen)}
          type="button"
        >
          <span aria-hidden="true">›</span>
        </button>
        <span className="copy-status" role="status">
          {copyStatus}
        </span>
      </div>
      {isPromptOpen && (
        <>
          <label className="sr-only" htmlFor="agent-setup-prompt">
            Setup prompt for your agent
          </label>
          <textarea
            className="setup-prompt-text"
            id="agent-setup-prompt"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            rows={14}
            value={setupPrompt}
          />
        </>
      )}
    </div>
  );

  return (
    <Placeholder title="Agent setup">
      {showSetupPrompt && (
        <section className="agent-service-entrance">
          <h2>Give your agent a secure service entrance</h2>
          <p>
            Copy the setup prompt, paste it into your agent&apos;s chat window, and answer a few
            questions. Homing will supply your agent with instructions and a unique key, which you
            can manage from this page.
          </p>
          {promptControls}
        </section>
      )}
      {hasActiveKey && (
        <>
          <section className="connection-summary">
            <h2>
              <span aria-hidden="true" className="connected-check">
                ✓
              </span>{" "}
              Your agent is connected
            </h2>
            <Message error={disconnectToken.error} />
            <div className="agent-key-table-wrap">
              <table className="agent-key-table">
                <caption className="sr-only">Active agent access keys</caption>
                <thead>
                  <tr>
                    <th scope="col">Connection</th>
                    <th scope="col">Activated</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Last used</th>
                    <th scope="col">
                      <span className="sr-only">Options</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayedActiveTokens.map((token) => (
                    <tr key={token.id}>
                      <th scope="row">
                        {token.name}
                        {token.prefix && (
                          <small className="agent-key-prefix">{token.prefix}…</small>
                        )}
                      </th>
                      <td>
                        <TokenDate value={token.created_at} empty="Not reported" />
                      </td>
                      <td>
                        <TokenDate value={token.expires_at} empty="Does not expire" />
                      </td>
                      <td>
                        <TokenDate
                          value={token.last_used_at}
                          empty={token.last_used_at === undefined ? "Not reported" : "Never"}
                        />
                      </td>
                      <td>
                        <button
                          className="plain-button disconnect-key"
                          disabled={previewActiveKey || disconnectToken.isPending}
                          onClick={() => disconnectToken.mutate(token.id)}
                          type="button"
                        >
                          Disconnect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="additional-agent-setup">
            <h3>Set up another agent</h3>
            {promptControls}
          </div>
        </>
      )}
      <details className="pairing-codes">
        <summary>Pairing codes</summary>
        <div className="pairing-codes-content">
          <section className="agent-pairing-entry">
            <h2>Pair an existing agent</h2>
            <p className="quiet">
              Enter the six-character code shown by an agent that is waiting for approval.
            </p>
            <form
              className="pairing-code-form"
              onSubmit={(event) => {
                event.preventDefault();
                navigate(`/link/?code=${encodeURIComponent(pairCode.trim().toUpperCase())}`);
              }}
            >
              <label>
                Pairing code
                <input
                  autoCapitalize="characters"
                  autoComplete="one-time-code"
                  inputMode="text"
                  maxLength={6}
                  onChange={(event) => setPairCode(event.target.value.replace(/[^a-z0-9]/gi, ""))}
                  required
                  spellCheck={false}
                  value={pairCode}
                />
              </label>
              <button className="button" disabled={pairCode.trim().length < 6} type="submit">
                Review request
              </button>
            </form>
          </section>
          <section className="manual-token-form">
            <h2>Create a manual access key</h2>
            <p className="quiet">
              Use this only when pairing is unavailable. The full key is shown once.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                createToken.mutate();
              }}
            >
              <label>
                Key name
                <input
                  autoComplete="off"
                  maxLength={120}
                  onChange={(event) => setKeyName(event.target.value)}
                  required
                  value={keyName}
                />
              </label>
              <Message error={createToken.error} />
              <button
                className="button"
                disabled={createToken.isPending || !keyName.trim()}
                type="submit"
              >
                {createToken.isPending ? "Creating…" : "Create access key"}
              </button>
            </form>
            {newAccessKey && (
              <div className="one-time-key" role="status">
                <strong>Copy this key now. It will not be shown again.</strong>
                <label>
                  New access key
                  <input aria-label="New access key" readOnly value={newAccessKey} />
                </label>
                <button
                  className="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(newAccessKey);
                      setCopyStatus("Access key copied.");
                    } catch {
                      setCopyStatus("Copy failed. Select the key manually.");
                    }
                  }}
                  type="button"
                >
                  Copy access key
                </button>
                <span className="copy-status">{copyStatus}</span>
              </div>
            )}
          </section>
        </div>
      </details>
      <Message error={tokens.error} />
      {tokens.isLoading && !previewActiveKey && (
        <p className="quiet small">Checking existing access keys…</p>
      )}
      {import.meta.env.DEV && (
        <label className="dev-preview-toggle">
          <input
            checked={previewActiveKey}
            onChange={(event) => setPreviewActiveKey(event.target.checked)}
            type="checkbox"
          />
          Preview active agent key
        </label>
      )}
    </Placeholder>
  );
}

type ProfilePatch = Pick<Profile, "display_name" | "timezone" | "bio">;

function ProfileSettingsForm({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const browserTimezone = detectedTimezone();
  const availableTimezones = timezoneOptions();
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [timezone, setTimezone] = useState(
    profile.timezone === "UTC" && browserTimezone !== "UTC" ? browserTimezone : profile.timezone,
  );
  const [bio, setBio] = useState(profile.bio);
  const [saveStatus, setSaveStatus] = useState("");
  const updateCachedProfile = (updatedProfile: Profile) => {
    queryClient.setQueryData(["profile"], updatedProfile);
    queryClient.setQueryData<Me>(["me"], (current) =>
      current
        ? {
            ...current,
            user: { ...current.user, display_name: updatedProfile.display_name },
            profile: updatedProfile,
          }
        : current,
    );
  };
  const saveProfile = useMutation({
    mutationFn: (patch: ProfilePatch) =>
      api<Profile>("/me/profile", {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify(patch),
      }),
    onSuccess: (updatedProfile) => {
      updateCachedProfile(updatedProfile);
      setSaveStatus("Profile saved.");
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaveStatus("");
    saveProfile.mutate({
      display_name: displayName.trim(),
      timezone: timezone.trim(),
      bio,
    });
  };

  return (
    <section aria-label="Profile" className="panel">
      <form className="settings-form" onSubmit={submit}>
        <div className="profile-fields">
          <label>
            Display name
            <input
              autoComplete="name"
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              value={displayName}
            />
          </label>
          <label>
            Timezone
            <select onChange={(event) => setTimezone(event.target.value)} required value={timezone}>
              <optgroup label="Detected from this browser">
                <option value={browserTimezone}>{timezoneLabel(browserTimezone)}</option>
              </optgroup>
              <optgroup label="All timezones, sorted by city">
                {availableTimezones.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="profile-field-wide">
            Bio
            <textarea
              maxLength={5000}
              onChange={(event) => setBio(event.target.value)}
              rows={5}
              value={bio}
            />
          </label>
        </div>
        <Message error={saveProfile.error} />
        <div className="settings-form-actions">
          <button className="button" disabled={saveProfile.isPending} type="submit">
            {saveProfile.isPending ? "Saving…" : "Save profile"}
          </button>
          <span className="copy-status" role="status">
            {saveStatus}
          </span>
        </div>
      </form>
    </section>
  );
}

function tokenState(token: AgentTokenSummary): "Active" | "Expired" | "Revoked" {
  if (token.revoked_at) return "Revoked";
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) return "Expired";
  return "Active";
}

const previewSettingsTokens: AgentTokenSummary[] = [
  {
    id: "preview-active-token",
    name: "Home computer",
    prefix: "homing_home",
    scopes: ["projects:read", "leads:read", "leads:write"],
    expires_at: "2035-11-10T14:30:00Z",
    revoked_at: null,
  },
  {
    id: "preview-expired-token",
    name: "Old laptop",
    prefix: "homing_laptop",
    scopes: ["projects:read", "leads:read"],
    expires_at: "2020-07-01T14:30:00Z",
    revoked_at: null,
  },
  {
    id: "preview-revoked-token",
    name: "Cloud experiment",
    prefix: "homing_cloud",
    scopes: ["projects:read"],
    expires_at: "2035-10-01T14:30:00Z",
    revoked_at: "2026-08-02T10:00:00Z",
  },
];

function AgentAccessSettings() {
  const queryClient = useQueryClient();
  const [previewHistory, setPreviewHistory] = useState(false);
  const tokens = useQuery({
    queryKey: ["agent-tokens"],
    queryFn: () => api<{ items: AgentTokenSummary[] }>("/auth/tokens"),
  });
  const revokeToken = useMutation({
    mutationFn: (tokenId: string) =>
      api<void>(`/auth/tokens/${tokenId}`, { method: "DELETE", mutation: true }),
    onSuccess: (_, tokenId) => {
      queryClient.setQueryData<{ items: AgentTokenSummary[] }>(["agent-tokens"], (current) => ({
        items:
          current?.items.map((token) =>
            token.id === tokenId ? { ...token, revoked_at: new Date().toISOString() } : token,
          ) ?? [],
      }));
    },
  });
  const displayedTokens = previewHistory ? previewSettingsTokens : (tokens.data?.items ?? []);

  return (
    <section className="panel">
      <div className="settings-section-heading">
        <h2>Agent access</h2>
        <Link to="/agent-setup">Manage agent setup</Link>
      </div>
      <p className="quiet">
        Review user-wide agent connections without exposing their access keys.
      </p>
      {import.meta.env.DEV && (
        <label className="dev-preview-toggle settings-preview-toggle">
          <input
            checked={previewHistory}
            onChange={(event) => setPreviewHistory(event.target.checked)}
            type="checkbox"
          />
          Preview agent access history
        </label>
      )}
      <Message error={tokens.error ?? revokeToken.error} />
      {tokens.isLoading && !previewHistory && <p className="quiet small">Loading connections…</p>}
      {!tokens.isLoading && displayedTokens.length === 0 && (
        <p className="quiet">No agent connections yet.</p>
      )}
      {displayedTokens.length > 0 && (
        <ul className="settings-token-list">
          {displayedTokens.map((token) => {
            const state = tokenState(token);
            return (
              <li key={token.id}>
                <div className="settings-token-identity">
                  <strong>{token.name}</strong>
                  <small>
                    {token.prefix ? `${token.prefix}… · ` : ""}
                    {token.scopes?.join(", ") || "No scopes"}
                  </small>
                </div>
                <span className="settings-token-expiry">
                  Expires <TokenDate value={token.expires_at} empty="never" />
                </span>
                <span className={`token-status is-${state.toLowerCase()}`}>{state}</span>
                {!token.revoked_at && (
                  <button
                    className="plain-button disconnect-key"
                    disabled={previewHistory || revokeToken.isPending}
                    onClick={() => revokeToken.mutate(token.id)}
                    type="button"
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SettingsPage({ me }: { me: Me }) {
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api<Profile>("/me/profile"),
    initialData: me.profile ?? undefined,
  });

  return (
    <main className="page">
      <header className="page-heading">
        <h1>Your profile</h1>
      </header>
      <Message error={profile.error} />
      {profile.isLoading && <p className="quiet">Loading profile…</p>}
      <div className="settings-stack">
        {profile.data && <ProfileSettingsForm profile={profile.data} />}
        <AgentAccessSettings />
      </div>
    </main>
  );
}

function AuthenticatedApp({ me }: { me: Me }) {
  return (
    <Shell me={me}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/invitations/:token/*" element={<InvitationPage authenticated />} />
        <Route path="/link/*" element={<PairingPage />} />
        <Route path="/projects/:projectId/leads/:leadId" element={<LeadPage />} />
        <Route path="/projects/:projectId/*" element={<ProjectPage currentUserId={me.user.id} />} />
        <Route path="/agent-setup" element={<AgentSetupPage />} />
        <Route path="/settings" element={<SettingsPage me={me} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [privateCacheUserId, setPrivateCacheUserId] = useState<number | null>(null);
  const previousUserId = useRef<number | null>(null);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: false,
    staleTime: 0,
  });
  const currentUserId = me.data?.user.id ?? null;
  const privateCacheReady = currentUserId !== null && privateCacheUserId === currentUserId;
  useLayoutEffect(() => {
    if (currentUserId === null) return;
    if (previousUserId.current !== null && previousUserId.current !== currentUserId) {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== "me",
      });
    }
    previousUserId.current = currentUserId;
    setPrivateCacheUserId(currentUserId);
  }, [currentUserId, queryClient]);
  useEffect(() => {
    const onExpired = () => {
      if (me.data) setSessionExpired(true);
    };
    window.addEventListener("homing:session-expired", onExpired);
    return () => window.removeEventListener("homing:session-expired", onExpired);
  }, [me.data]);
  const completeLogin = () => {
    const next = new URLSearchParams(location.search).get("next");
    if (location.pathname === "/login") {
      navigate(next?.startsWith("/") && !next.startsWith("//") ? next : "/", {
        replace: true,
      });
    }
    setSessionExpired(false);
  };
  let content: ReactNode;
  let defaultBackground: BackgroundId = "interior-brownstone";

  if (sessionExpired && me.data && privateCacheReady) {
    content = (
      <div className="app-frame">
        <div aria-hidden="true" className="app-suspended" inert>
          <AuthenticatedApp key={me.data.user.id} me={me.data} />
        </div>
        <div aria-label="Sign in again" aria-modal="true" className="reauth-overlay" role="dialog">
          <LoginPage heading="Sign in again" onAuthenticated={completeLogin} />
        </div>
      </div>
    );
    defaultBackground = "exterior-leafy-block";
  } else if (sessionExpired) {
    content = <LoginPage heading="Sign in again" onAuthenticated={completeLogin} />;
    defaultBackground = "exterior-leafy-block";
  } else if (me.isLoading) content = <Loading />;
  else if (me.error instanceof ApiError && me.error.status === 401) {
    const invitationPath = /^\/invitations\/[^/]+(?:\/accept)?\/?$/.test(location.pathname);
    const pairingPath = /^\/link\/?$/.test(location.pathname);
    content = invitationPath ? (
      <InvitationPage />
    ) : (
      <LoginPage
        heading={pairingPath ? "Sign in to approve" : "Sign in"}
        onAuthenticated={completeLogin}
      />
    );
    defaultBackground = "exterior-leafy-block";
  } else if (me.error) {
    content = (
      <main className="center">
        <div className="panel">
          <h1>Homing is unavailable</h1>
          <Message error={me.error} />
          <button className="button" onClick={() => me.refetch()} type="button">
            Try again
          </button>
        </div>
      </main>
    );
  } else if (me.data && location.pathname === "/login") {
    content = <LoginPage onAuthenticated={completeLogin} />;
    defaultBackground = "exterior-leafy-block";
  } else if (me.data && privateCacheReady) {
    content = (
      <div className="app-frame">
        <div className="app-authenticated">
          <AuthenticatedApp key={me.data.user.id} me={me.data} />
        </div>
      </div>
    );
  } else if (location.pathname === "/login") {
    content = <LoginPage onAuthenticated={completeLogin} />;
    defaultBackground = "exterior-leafy-block";
  } else content = <Loading />;

  return (
    <>
      {content}
      <BackgroundPicker defaultBackground={defaultBackground} />
    </>
  );
}
