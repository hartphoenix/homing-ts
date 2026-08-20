import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useParams, useSearchParams } from "react-router";

import {
  ApiError,
  api,
  type Comment,
  clearCsrf,
  type Lead,
  login,
  type Me,
  type Project,
} from "./api";

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
        <p className="eyebrow">Shared search</p>
        <h1>Find the next place together.</h1>
        <p>One live brief for the people and agents doing the search.</p>
      </section>
      <form className="panel login-form" onSubmit={submit}>
        <div>
          <p className="eyebrow">Welcome back</p>
          <h2>Sign in</h2>
        </div>
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
        <p className="quiet small">Access is invitation-only.</p>
      </form>
    </main>
  );
}

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const queryClient = useQueryClient();
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
        <nav aria-label="Primary">
          <NavLink to="/">Searches</NavLink>
          <NavLink to="/agent-setup">Agent setup</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <button className="plain-button" onClick={() => logout.mutate()} type="button">
          {me.profile?.display_name || me.user.email} · Sign out
        </button>
      </header>
      {children}
    </div>
  );
}

function Dashboard() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
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
        body: JSON.stringify({ name, prompt, criteria: {} }),
      }),
    onSuccess: async () => {
      setName("");
      setPrompt("");
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return (
    <main className="page">
      <header className="page-heading split">
        <div>
          <p className="eyebrow">Search parties</p>
          <h1>Your shared searches</h1>
          <p>Every project holds one current brief, its leads, and everyone contributing.</p>
        </div>
        <button
          className="button primary"
          onClick={() => setCreating((value) => !value)}
          type="button"
        >
          {creating ? "Cancel" : "New search"}
        </button>
      </header>
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
      <Message error={projects.error} />
      <section className="project-grid" aria-live="polite">
        {projects.data?.items.map((project) => (
          <Link className="project-card" key={project.id} to={`/projects/${project.id}`}>
            <div>
              <span className="status-dot" />
              <span className="quiet small">{project.role ?? "Member"}</span>
            </div>
            <h2>{project.name}</h2>
            <p>{project.description || "No description yet."}</p>
            <footer>
              <span>Brief v{project.prompt_revision}</span>
              <span>Open search →</span>
            </footer>
          </Link>
        ))}
        {projects.data?.items.length === 0 && (
          <div className="empty">
            <h2>No searches yet</h2>
            <p>Start one shared brief, then connect the people and agents helping with it.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function LeadIndex({ projectId }: { projectId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const status = searchParams.get("status") === "trash" ? "trash" : "active";
  const leads = useQuery({
    queryKey: ["leads", projectId, query, status, searchParams.get("sort")],
    queryFn: () => {
      const params = new URLSearchParams({
        q: query,
        status,
        sort: searchParams.get("sort") ?? "updated",
        limit: "50",
      });
      const path =
        status === "trash"
          ? `/projects/${projectId}/trash?${params}`
          : `/projects/${projectId}/leads?${params}`;
      return api<{ items: Lead[]; next_cursor?: string | null }>(path);
    },
  });
  return (
    <>
      <div className="lead-tools">
        <input
          aria-label="Search leads"
          placeholder="Search title or location"
          value={query}
          onChange={(event) => {
            const next = new URLSearchParams(searchParams);
            event.target.value ? next.set("q", event.target.value) : next.delete("q");
            setSearchParams(next, { replace: true });
          }}
        />
        <select
          aria-label="Lead status"
          value={status}
          onChange={(event) => {
            const next = new URLSearchParams(searchParams);
            event.target.value === "trash" ? next.set("status", "trash") : next.delete("status");
            setSearchParams(next);
          }}
        >
          <option value="active">Active</option>
          <option value="trash">Trash</option>
        </select>
      </div>
      <Message error={leads.error} />
      <section className="lead-list">
        {leads.data?.items.map((lead) => (
          <Link className="lead-card" key={lead.id} to={`/projects/${projectId}/leads/${lead.id}`}>
            <div className="lead-card-top">
              <span className="source">{lead.source}</span>
              <span className="price">{lead.price_display || "Price unknown"}</span>
            </div>
            <h2>{lead.title}</h2>
            <p>{[lead.location, lead.availability].filter(Boolean).join(" · ")}</p>
            <p className="clamp">{lead.summary}</p>
            <footer>
              <span>{lead.interest_count ? `♥ ${lead.interest_count}` : "No interest yet"}</span>
              <span>Review →</span>
            </footer>
          </Link>
        ))}
        {leads.data?.items.length === 0 && (
          <div className="empty">
            <h2>No leads here</h2>
            <p>The shared search is ready for its next result.</p>
          </div>
        )}
      </section>
    </>
  );
}

function ProjectPage() {
  const { projectId = "" } = useParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
  if (project.isLoading) return <Loading />;
  return (
    <main className="page project-page">
      <header className="page-heading">
        <Link className="back" to="/">
          ← Searches
        </Link>
        <p className="eyebrow">{project.data?.role ?? "Shared search"}</p>
        <h1>{project.data?.name}</h1>
        <p>{project.data?.description}</p>
      </header>
      <nav className="tabs" aria-label="Project">
        <NavLink end to={`/projects/${projectId}`}>
          Leads
        </NavLink>
        <NavLink to={`/projects/${projectId}/brief`}>Brief</NavLink>
        <NavLink to={`/projects/${projectId}/members`}>People</NavLink>
      </nav>
      <Routes>
        <Route index element={<LeadIndex projectId={projectId} />} />
        <Route
          path="brief"
          element={project.data ? <BriefEditor project={project.data} /> : null}
        />
        <Route path="members" element={<Members projectId={projectId} />} />
      </Routes>
    </main>
  );
}

function BriefEditor({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(project.prompt ?? project.current_prompt ?? "");
  const [criteria, setCriteria] = useState(JSON.stringify(project.criteria ?? {}, null, 2));
  useEffect(() => {
    setPrompt(project.prompt ?? project.current_prompt ?? "");
    setCriteria(JSON.stringify(project.criteria ?? {}, null, 2));
  }, [project]);
  const mutation = useMutation({
    mutationFn: () =>
      api(`/projects/${project.id}/prompt`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({
          prompt,
          criteria: JSON.parse(criteria),
          expected_revision: project.prompt_revision,
        }),
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  return (
    <form
      className="panel editor"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <div>
        <p className="eyebrow">Current brief · v{project.prompt_revision}</p>
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
      <label>
        Structured criteria
        <textarea
          className="code"
          rows={9}
          value={criteria}
          onChange={(event) => setCriteria(event.target.value)}
        />
      </label>
      <Message error={mutation.error} />
      {mutation.error instanceof ApiError && mutation.error.status === 409 && (
        <p className="message">
          Your draft is still here. Reload the current brief in another tab before deciding what to
          keep.
        </p>
      )}
      <button className="button primary" disabled={mutation.isPending} type="submit">
        Save new revision
      </button>
    </form>
  );
}

function Members({ projectId }: { projectId: string }) {
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () =>
      api<{
        items: Array<{ user_id: number; display_name: string; email: string; role: string }>;
      }>(`/projects/${projectId}/members`),
  });
  return (
    <section className="panel">
      <p className="eyebrow">People</p>
      <h2>Search party</h2>
      <Message error={members.error} />
      <div className="member-list">
        {members.data?.items.map((member) => (
          <div key={member.user_id}>
            <span className="avatar">{member.display_name?.slice(0, 1) || "?"}</span>
            <div>
              <strong>{member.display_name}</strong>
              <p className="quiet small">{member.email}</p>
            </div>
            <span className="pill">{member.role}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function LeadPage() {
  const { projectId = "", leadId = "" } = useParams();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const lead = useQuery({
    queryKey: ["lead", projectId, leadId],
    queryFn: () => api<Lead>(`/projects/${projectId}/leads/${leadId}`),
  });
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
  return (
    <main className="page detail-page">
      <Link className="back" to={`/projects/${projectId}`}>
        ← All leads
      </Link>
      <Message error={lead.error} />
      {lead.data && (
        <>
          <header className="detail-heading">
            <div>
              <span className="source">{lead.data.source}</span>
              <h1>{lead.data.title}</h1>
              <p>{[lead.data.location, lead.data.availability].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="detail-price">
              <strong>{lead.data.price_display || "Price unknown"}</strong>
              <a className="button primary" href={lead.data.url} target="_blank" rel="noreferrer">
                Open listing ↗
              </a>
            </div>
          </header>
          <div className="detail-grid">
            <article className="panel prose">
              <h2>What we know</h2>
              <p>{lead.data.summary || "No summary yet."}</p>
            </article>
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
        <p className="eyebrow">Homing</p>
        <h1>{title}</h1>
      </header>
      <section className="panel prose">{children}</section>
    </main>
  );
}

function AuthenticatedApp({ me }: { me: Me }) {
  return (
    <Shell me={me}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects/:projectId/leads/:leadId" element={<LeadPage />} />
        <Route path="/projects/:projectId/*" element={<ProjectPage />} />
        <Route
          path="/agent-setup"
          element={
            <Placeholder title="Agent setup">
              <h2>Give an agent a secure way in</h2>
              <p>
                Use device pairing or create a revocable access key. Pairing and source-plan repair
                controls will appear here as the backend slices are integrated.
              </p>
            </Placeholder>
          }
        />
        <Route
          path="/settings"
          element={
            <Placeholder title="Settings">
              <h2>Profile and schedules</h2>
              <p>
                Manage your profile, server-side search pause, access keys, and open source-plan
                reviews here.
              </p>
            </Placeholder>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), retry: false });
  if (me.isLoading) return <Loading />;
  if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
  if (me.error)
    return (
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
  return me.data ? <AuthenticatedApp me={me.data} /> : <Loading />;
}
