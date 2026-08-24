import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
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
  type Lead,
  login,
  type Me,
  type Profile,
  type Project,
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
  const text = error instanceof Error ? error.message : "The request could not be completed.";
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

function LoginPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: async () => {
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
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
        <h2>Sign in</h2>
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
        <button className="button primary" disabled={mutation.isPending} type="submit">
          {mutation.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
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
          <button className="button primary" disabled={create.isPending} type="submit">
            Create search
          </button>
        </form>
      )}
      <button
        className="button primary dashboard-action"
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
  const leads = useQuery({
    queryKey: ["leads", projectId, query, status, searchParams.get("sort")],
    queryFn: () => {
      const params = new URLSearchParams({
        q: query,
        status,
        sort,
        limit: "50",
      });
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
  const setSort = (column: "price" | "source" | "days") => {
    const next = new URLSearchParams(searchParams);
    const current = searchParams.get("sort") ?? "";
    next.set("sort", current === `${column}_asc` ? `${column}_desc` : `${column}_asc`);
    setSearchParams(next);
  };
  const sortDirection = (column: "price" | "source" | "days") =>
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
      {view === "cards" ? (
        <section className="lead-list" aria-label="Lead cards">
          {leads.data?.items.map((lead) => (
            <article className="lead-card" key={lead.id}>
              <Link
                className="lead-card-hit"
                aria-label={lead.title}
                to={`/projects/${projectId}/leads/${lead.id}`}
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
                <span>
                  <span aria-hidden="true">
                    {lead.interest_count ? `${lead.interest_count} ♥` : "♡"}
                  </span>
                  <span className="sr-only">{lead.interest_count ?? 0} interested</span>
                </span>
                {Boolean(lead.comment_count) && (
                  <span>
                    {lead.comment_count} {lead.comment_count === 1 ? "comment" : "comments"}
                  </span>
                )}
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
              <h2>No leads here</h2>
              <p>The shared search is ready for its next result.</p>
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
                    <Link to={`/projects/${projectId}/leads/${lead.id}`}>
                      <strong>{lead.title}</strong>
                      <span className="lead-location">{lead.location || "Location unknown"}</span>
                    </Link>
                  </td>
                  <td>{lead.price_display ? listPrice(lead.price_display) : "Unknown"}</td>
                  <td>{compactDaysOnMarket(lead.listed_at)}</td>
                  <td>
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
                  </td>
                  <td>{lead.comment_count || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {leads.data?.items.length === 0 && (
            <div className="empty">
              <h2>No leads here</h2>
              <p>The shared search is ready for its next result.</p>
            </div>
          )}
        </div>
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
  return (
    <main className="page project-page">
      <header className="page-heading">
        <h1>{project.data?.name}</h1>
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
  useEffect(() => {
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
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });
  const mutation = useMutation({
    mutationFn: () =>
      api(`/projects/${project.id}/prompt`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({
          prompt,
          criteria: project.criteria ?? {},
          expected_revision: project.prompt_revision,
        }),
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
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
            onChange={(event) => setDescription(event.target.value)}
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
            onChange={(event) => setPrompt(event.target.value)}
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
  role: string;
};

type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  status: "pending";
  expires_at: string;
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
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api<MembersData>(`/projects/${projectId}/members`),
  });
  const invite = useMutation({
    mutationFn: (invitedEmail: string) =>
      api<{ id: string; role: string; expires_at: string }>(`/projects/${projectId}/invitations`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ email: invitedEmail, role: "viewer" }),
      }),
    onSuccess: (invitation, invitedEmail) => {
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

  const pendingInvitations = members.data?.pending_invitations ?? [];

  return (
    <section className="panel">
      <h2>Search party</h2>
      <Message error={members.error} />
      <Message error={invite.error ?? removeMember.error ?? cancelInvitation.error} />
      <div className="member-list">
        {members.data?.items.map((member) => (
          <div className="member-row" key={member.user_id}>
            <span className="avatar">{member.display_name?.slice(0, 1) || "?"}</span>
            <div className="member-identity">
              <strong>{member.display_name}</strong>
              <p className="quiet small">{member.email}</p>
            </div>
            <span className="pill">{member.role}</span>
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
            <button className="button primary" disabled={invite.isPending} type="submit">
              {invite.isPending ? "Sending…" : "Send"}
            </button>
          </form>
        )}
      </div>
      {!isInviting && (
        <button className="button invite-trigger" onClick={() => setIsInviting(true)} type="button">
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
  const [comment, setComment] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftListedAt, setDraftListedAt] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  const lead = useQuery({
    queryKey: ["lead", projectId, leadId],
    queryFn: () => api<Lead>(`/projects/${projectId}/leads/${leadId}`),
  });
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
      queryClient.setQueryData(["lead", projectId, leadId], updatedLead);
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
  return (
    <main className="page detail-page">
      <Link className="back" to={`/projects/${projectId}`}>
        ← All {project.data?.name ? `${project.data.name} ` : ""}leads
      </Link>
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
            <a className="button primary" href={lead.data.url} target="_blank" rel="noreferrer">
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
              <Message error={updateLead.error ?? setInterest.error ?? trashLead.error} />
              {isEditing ? (
                <div className="lead-edit-actions">
                  <button className="button" onClick={() => setIsEditing(false)} type="button">
                    Cancel
                  </button>
                  <button
                    className="button primary"
                    disabled={updateLead.isPending || !draftTitle.trim()}
                    onClick={() => updateLead.mutate()}
                    type="button"
                  >
                    {updateLead.isPending ? "Saving…" : "Save lead"}
                  </button>
                </div>
              ) : (
                <div className="lead-detail-actions">
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
                  <button
                    aria-label="Move to trash"
                    className="icon-button"
                    disabled={trashLead.isPending}
                    onClick={() => trashLead.mutate()}
                    title="Move to trash"
                    type="button"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
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
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [previewActiveKey, setPreviewActiveKey] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
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
  const disconnectToken = useMutation({
    mutationFn: (tokenId: string) =>
      api<void>(`/auth/tokens/${tokenId}`, { method: "DELETE", mutation: true }),
    onSuccess: async () => {
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
        <button
          className={`button${showSetupPrompt ? " primary" : ""}`}
          type="button"
          onClick={copySetupPrompt}
        >
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
      <Message error={tokens.error} />
      {tokens.isLoading && !previewActiveKey && (
        <p className="quiet small">Checking existing access keys…</p>
      )}
      {showSetupPrompt && (
        <>
          <h2>Give your agent a secure service entrance</h2>
          <p>
            Copy the setup prompt, paste it into your agent&apos;s chat window, and answer a few
            questions. Homing will supply your agent with instructions and a unique key, which you
            can manage from this page.
          </p>
          {promptControls}
        </>
      )}
      {hasActiveKey && (
        <>
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
                      {token.prefix && <small className="agent-key-prefix">{token.prefix}…</small>}
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
          <div className="additional-agent-setup">
            <h3>Set up another agent</h3>
            {promptControls}
          </div>
        </>
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
  const saveProfile = useMutation({
    mutationFn: (patch: ProfilePatch) =>
      api<Profile>("/me/profile", {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify(patch),
      }),
    onSuccess: (updatedProfile) => {
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
          <button className="button primary" disabled={saveProfile.isPending} type="submit">
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
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), retry: false });
  let content: ReactNode;
  let defaultBackground: BackgroundId = "interior-brownstone";

  if (me.isLoading) content = <Loading />;
  else if (me.error instanceof ApiError && me.error.status === 401) {
    content = <LoginPage />;
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
  } else content = me.data ? <AuthenticatedApp me={me.data} /> : <Loading />;

  return (
    <>
      {content}
      <BackgroundPicker defaultBackground={defaultBackground} />
    </>
  );
}
