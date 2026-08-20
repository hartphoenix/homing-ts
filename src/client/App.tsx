import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
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

import {
  type AgentToken,
  ApiError,
  api,
  apiResponse,
  type Comment,
  clearCsrf,
  type Lead,
  login,
  type Me,
  type Member,
  type Project,
  registerInvitation,
  type SourcePlanReview,
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

function LoginPage({ expired = false, onSuccess }: { expired?: boolean; onSuccess?: () => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: async () => {
      setPassword("");
      onSuccess?.();
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
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
      <form
        className="panel login-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div>
          <p className="eyebrow">{expired ? "Session ended" : "Welcome back"}</p>
          <h2>{expired ? "Sign in again" : "Sign in"}</h2>
          {expired && <p className="message">Your session expired. Sign in again to continue.</p>}
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

type InvitationDetails = {
  email: string;
  role: "editor" | "viewer";
  project: { id: string; name: string };
  inviter_name: string;
  expires_at: string;
};

function InvitationPage({
  token,
  authenticated,
  onComplete,
}: {
  token: string;
  authenticated: boolean;
  onComplete: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"register" | "signin">("register");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const details = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api<InvitationDetails>(`/invitations/${encodeURIComponent(token)}/accept`),
    retry: false,
  });
  useEffect(() => {
    if (details.data?.email) setEmail(details.data.email);
  }, [details.data?.email]);
  const accept = useMutation({
    mutationFn: () =>
      api<{ project_id: string }>(`/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        mutation: true,
      }),
    onSuccess: ({ project_id }) => onComplete(project_id),
  });
  const register = useMutation({
    mutationFn: async () => {
      if (password !== confirmation) throw new Error("Passwords do not match.");
      return registerInvitation(token, {
        email,
        display_name: displayName,
        password,
      });
    },
    onSuccess: async ({ project_id }) => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      onComplete(project_id);
    },
  });
  const signIn = useMutation({
    mutationFn: async () => {
      await login(email, password);
      return api<{ project_id: string }>(`/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        mutation: true,
      });
    },
    onSuccess: async ({ project_id }) => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      onComplete(project_id);
    },
  });
  if (details.isLoading) return <Loading />;
  return (
    <main className="login-page">
      <section className="login-intro">
        <Link className="wordmark" to="/">
          Homing
        </Link>
        <p className="eyebrow">Invitation</p>
        <h1>{details.data?.project.name ?? "Join a shared search"}</h1>
        {details.data && (
          <p>
            {details.data.inviter_name || "A search partner"} invited {details.data.email} as an{" "}
            {details.data.role}.
          </p>
        )}
      </section>
      <section className="panel login-form">
        <Message error={details.error ?? accept.error ?? register.error ?? signIn.error} />
        {authenticated ? (
          <>
            <h2>Accept invitation</h2>
            <p>This invitation can only be accepted by its exact email recipient.</p>
            <button
              className="button primary"
              disabled={accept.isPending || !details.data}
              onClick={() => accept.mutate()}
              type="button"
            >
              Join search party
            </button>
          </>
        ) : (
          <form
            className="editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (mode === "register") register.mutate();
              else signIn.mutate();
            }}
          >
            <h2>{mode === "register" ? "Create your account" : "Sign in to accept"}</h2>
            {mode === "register" && (
              <label>
                Display name
                <input
                  autoComplete="name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                />
              </label>
            )}
            <label>
              Email
              <input autoComplete="email" type="email" value={email} readOnly required />
            </label>
            <label>
              Password
              <input
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                minLength={mode === "register" ? 12 : undefined}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {mode === "register" && (
              <label>
                Confirm password
                <input
                  autoComplete="new-password"
                  minLength={12}
                  type="password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                />
              </label>
            )}
            <button
              className="button primary"
              disabled={register.isPending || signIn.isPending || !details.data}
              type="submit"
            >
              {mode === "register" ? "Create account and join" : "Sign in and join"}
            </button>
            <button
              className="plain-button"
              onClick={() => {
                setMode(mode === "register" ? "signin" : "register");
                setPassword("");
                setConfirmation("");
              }}
              type="button"
            >
              {mode === "register" ? "I already have an account" : "I need an account"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

function SourcePlanBanner() {
  const reviews = useQuery({
    queryKey: ["source-plan-reviews"],
    queryFn: () => api<{ items: SourcePlanReview[] }>("/me/source-plan-reviews?status=open"),
    retry: false,
  });
  const count = reviews.data?.items.length ?? 0;
  if (!count) return null;
  return (
    <aside className="source-plan-banner" aria-label="Source plan review">
      <p>
        <strong>Your installed source plan needs review</strong> for {count} active search
        {count === 1 ? "" : "es"}.
      </p>
      <Link className="button primary" to="/settings#source-plan-review">
        Review with your assistant
      </Link>
    </aside>
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
      <SourcePlanBanner />
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

type LeadPageResponse = { items: Lead[]; next_cursor?: string | null };

function LeadIndex({ projectId }: { projectId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const status = searchParams.get("status") === "trashed" ? "trashed" : "active";
  const interest = searchParams.get("interest") ?? "all";
  const sort = searchParams.get("sort") ?? "updated";
  const view = searchParams.get("view") === "list" ? "list" : "cards";
  const cursor = searchParams.get("cursor") ?? "";
  const leads = useQuery({
    queryKey: ["leads", projectId, query, status, interest, sort, view, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "24" });
      if (status === "active") {
        params.set("status", status);
        params.set("sort", sort);
        if (query) params.set("q", query);
        if (interest !== "all")
          params.set("interested_by", interest === "anyone" ? "any" : interest);
      }
      if (cursor) params.set("cursor", cursor);
      const path =
        status === "trashed"
          ? `/projects/${projectId}/trash?${params}`
          : `/projects/${projectId}/leads?${params}`;
      return api<LeadPageResponse>(path);
    },
  });
  const update = (name: string, value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value && value !== "all" && !(name === "status" && value === "active"))
      next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setSearchParams(next, { replace: name === "q" });
  };
  return (
    <>
      <div className="lead-tools">
        <input
          aria-label="Search leads"
          placeholder="Search title or location"
          value={query}
          onChange={(event) => update("q", event.target.value)}
        />
        <select
          aria-label="Lead status"
          value={status}
          onChange={(event) => update("status", event.target.value)}
        >
          <option value="active">Active</option>
          <option value="trashed">Trash</option>
        </select>
        <select
          aria-label="Interest filter"
          value={interest}
          onChange={(event) => update("interest", event.target.value)}
        >
          <option value="all">All interest</option>
          <option value="me">Interested by me</option>
          <option value="anyone">Interested by anyone</option>
        </select>
        <select
          aria-label="Lead sort"
          value={sort}
          onChange={(event) => update("sort", event.target.value)}
        >
          <option value="updated">Recently updated</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="interest">Most interest</option>
        </select>
        <fieldset className="view-toggle">
          <legend className="sr-only">Lead view</legend>
          <button
            className={`button ${view === "cards" ? "selected" : ""}`}
            onClick={() => update("view", "cards")}
            type="button"
          >
            Cards
          </button>
          <button
            className={`button ${view === "list" ? "selected" : ""}`}
            onClick={() => update("view", "list")}
            type="button"
          >
            List
          </button>
        </fieldset>
      </div>
      <Message error={leads.error} />
      <section className={`lead-list ${view === "list" ? "list-view" : ""}`} aria-live="polite">
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
              <span>{lead.comment_count ? `${lead.comment_count} comments` : "Review →"}</span>
            </footer>
          </Link>
        ))}
        {leads.data?.items.length === 0 && (
          <div className="empty">
            <h2>{status === "trashed" ? "Trash is empty" : "No leads here"}</h2>
            <p>The shared search is ready for its next result.</p>
          </div>
        )}
      </section>
      {(cursor || leads.data?.next_cursor) && (
        <nav className="pagination" aria-label="Lead pages">
          <button
            className="button"
            disabled={!cursor}
            onClick={() => update("cursor")}
            type="button"
          >
            First page
          </button>
          <button
            className="button"
            disabled={!leads.data?.next_cursor}
            onClick={() => update("cursor", leads.data?.next_cursor ?? "")}
            type="button"
          >
            Next page →
          </button>
        </nav>
      )}
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
  if (!project.data) return <Message error={project.error} />;
  return (
    <main className="page project-page">
      <header className="page-heading">
        <Link className="back" to="/">
          ← Searches
        </Link>
        <p className="eyebrow">{project.data.role ?? "Shared search"}</p>
        <h1>{project.data.name}</h1>
        <p>{project.data.description}</p>
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
        <Route path="brief" element={<BriefEditor project={project.data} />} />
        <Route
          path="members"
          element={<Members projectId={projectId} role={project.data.role} />}
        />
      </Routes>
    </main>
  );
}

function BriefEditor({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [prompt, setPrompt] = useState(project.prompt ?? project.current_prompt ?? "");
  const [criteria, setCriteria] = useState(JSON.stringify(project.criteria ?? {}, null, 2));
  const [criteriaError, setCriteriaError] = useState("");
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setPrompt(project.prompt ?? project.current_prompt ?? "");
    setCriteria(JSON.stringify(project.criteria ?? {}, null, 2));
  }, [project]);
  const projectMutation = useMutation({
    mutationFn: () =>
      api(`/projects/${project.id}`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ name, description }),
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const promptMutation = useMutation({
    mutationFn: () => {
      try {
        const parsed = JSON.parse(criteria);
        setCriteriaError("");
        return api(`/projects/${project.id}/prompt`, {
          method: "PUT",
          mutation: true,
          body: JSON.stringify({
            prompt,
            criteria: parsed,
            expected_revision: project.prompt_revision,
          }),
        });
      } catch {
        setCriteriaError("Criteria must be valid JSON.");
        throw new Error("Criteria must be valid JSON.");
      }
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  return (
    <div className="editor-stack">
      <form
        className="panel editor"
        onSubmit={(event) => {
          event.preventDefault();
          projectMutation.mutate();
        }}
      >
        <div>
          <p className="eyebrow">Search details</p>
          <h2>About this search</h2>
        </div>
        <label>
          Search name
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            maxLength={5000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <Message error={projectMutation.error} />
        <button className="button" disabled={projectMutation.isPending} type="submit">
          Save search details
        </button>
      </form>
      <form
        className="panel editor"
        onSubmit={(event) => {
          event.preventDefault();
          promptMutation.mutate();
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
        {criteriaError && (
          <p className="message error" role="alert">
            {criteriaError}
          </p>
        )}
        <Message error={promptMutation.error} />
        {promptMutation.error instanceof ApiError && promptMutation.error.status === 409 && (
          <p className="message">
            Your draft is still here. The brief changed elsewhere; reload the current version in
            another tab before deciding what to keep.
          </p>
        )}
        <button className="button primary" disabled={promptMutation.isPending} type="submit">
          Save new revision
        </button>
      </form>
    </div>
  );
}

function Members({ projectId, role }: { projectId: string; role?: Project["role"] }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [inviteUrl, setInviteUrl] = useState("");
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api<{ items: Member[] }>(`/projects/${projectId}/members`),
  });
  const invite = useMutation({
    mutationFn: () =>
      api<{ invite_url?: string; url?: string }>(`/projects/${projectId}/invitations`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ email, role: inviteRole }),
      }),
    onSuccess: (result) => {
      setEmail("");
      const path = result.invite_url ?? result.url;
      setInviteUrl(path ? new URL(path, window.location.origin).toString() : "");
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, nextRole }: { userId: Member["user_id"]; nextRole: Member["role"] }) =>
      api(`/projects/${projectId}/members`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ user_id: userId, role: nextRole }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", projectId] }),
  });
  const remove = useMutation({
    mutationFn: (userId: Member["user_id"]) =>
      api<void>(`/projects/${projectId}/members`, {
        method: "DELETE",
        mutation: true,
        body: JSON.stringify({ user_id: userId }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", projectId] }),
  });
  const mutationError = invite.error ?? changeRole.error ?? remove.error;
  const isOwnerError =
    mutationError instanceof ApiError &&
    ["final_owner", "last_owner", "owner_required", "final_owner_invariant"].includes(
      mutationError.code,
    );
  return (
    <section className="panel members-panel">
      <p className="eyebrow">People</p>
      <h2>Search party</h2>
      <Message error={members.error} />
      {mutationError && (
        <p className="message error" role="alert">
          {isOwnerError
            ? "This project must keep at least one owner. Promote another member before removing or demoting the final owner."
            : (mutationError as Error).message}
        </p>
      )}
      {role === "owner" && (
        <form
          className="invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <label>
            Invite someone
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
              required
            />
          </label>
          <label>
            Role
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button className="button primary" disabled={invite.isPending} type="submit">
            Create invitation
          </button>
        </form>
      )}
      {inviteUrl && (
        <div className="message" role="status">
          <strong>Invitation ready.</strong>
          <p>Share this link once; it expires according to the server policy.</p>
          <div className="copy-row">
            <input aria-label="Invitation link" readOnly value={inviteUrl} />
            <button
              className="button"
              onClick={() => navigator.clipboard?.writeText(inviteUrl)}
              type="button"
            >
              Copy
            </button>
          </div>
        </div>
      )}
      <div className="member-list">
        {members.data?.items.map((member) => (
          <div key={String(member.user_id)}>
            <span className="avatar">{member.display_name?.slice(0, 1) || "?"}</span>
            <div>
              <strong>{member.display_name || member.email}</strong>
              <p className="quiet small">{member.email}</p>
            </div>
            {role === "owner" ? (
              <select
                aria-label={`Role for ${member.display_name || member.email}`}
                value={member.role}
                onChange={(event) =>
                  changeRole.mutate({
                    userId: member.user_id,
                    nextRole: event.target.value as Member["role"],
                  })
                }
              >
                <option value="owner">Owner</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            ) : (
              <span className="pill">{member.role}</span>
            )}
            {role === "owner" && (
              <button
                className="plain-button danger"
                onClick={() => remove.mutate(member.user_id)}
                type="button"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LeadPage() {
  const { projectId = "", leadId = "" } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me") });
  const [comment, setComment] = useState("");
  const [editingComment, setEditingComment] = useState<Comment["id"] | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [editingLead, setEditingLead] = useState(false);
  const [leadDraft, setLeadDraft] = useState<Partial<Lead>>({});
  const lead = useQuery({
    queryKey: ["lead", projectId, leadId],
    queryFn: async () => {
      const result = await apiResponse<Lead>(`/projects/${projectId}/leads/${leadId}`);
      return { lead: result.data, etag: result.headers.get("ETag") };
    },
  });
  const leadData = lead.data?.lead;
  useEffect(() => {
    if (leadData) setLeadDraft(leadData);
  }, [leadData]);
  const comments = useQuery({
    queryKey: ["comments", projectId, leadId],
    queryFn: () => api<{ items: Comment[] }>(`/projects/${projectId}/leads/${leadId}/comments`),
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["lead", projectId, leadId] }),
      queryClient.invalidateQueries({ queryKey: ["leads", projectId] }),
    ]);
  };
  const interest = useMutation({
    mutationFn: (next: boolean) =>
      api<void>(`/projects/${projectId}/leads/${leadId}/interest`, {
        method: next ? "PUT" : "DELETE",
        mutation: true,
      }),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: () =>
      api<Lead>(`/projects/${projectId}/leads/${leadId}`, {
        method: "PATCH",
        mutation: true,
        headers: { "If-Match": lead.data?.etag ?? String(leadData?.revision ?? "") },
        body: JSON.stringify({
          title: leadDraft.title,
          url: leadDraft.url,
          summary: leadDraft.summary,
          location: leadDraft.location,
          price_display: leadDraft.price_display,
          availability: leadDraft.availability,
          housing_type: leadDraft.housing_type,
          date_confidence: leadDraft.date_confidence,
        }),
      }),
    onSuccess: async () => {
      setEditingLead(false);
      await refresh();
    },
  });
  const trash = useMutation({
    mutationFn: () =>
      api<void>(`/projects/${projectId}/leads/${leadId}`, {
        method: "DELETE",
        mutation: true,
        headers: { "If-Match": lead.data?.etag ?? String(leadData?.revision ?? "") },
        body: JSON.stringify({}),
      }),
    onSuccess: async () => {
      await refresh();
      navigate(`/projects/${projectId}`);
    },
  });
  const restore = useMutation({
    mutationFn: () =>
      api<Lead>(`/projects/${projectId}/trash/${leadId}/restore`, {
        method: "POST",
        mutation: true,
        headers: { "If-Match": lead.data?.etag ?? String(leadData?.revision ?? "") },
      }),
    onSuccess: refresh,
  });
  const addComment = useMutation({
    mutationFn: () =>
      api<Comment>(`/projects/${projectId}/leads/${leadId}/comments`, {
        method: "POST",
        mutation: true,
        body: JSON.stringify({ body: comment }),
      }),
    onSuccess: async () => {
      setComment("");
      await queryClient.invalidateQueries({ queryKey: ["comments", projectId, leadId] });
    },
  });
  const updateComment = useMutation({
    mutationFn: ({ id, body }: { id: Comment["id"]; body: string }) =>
      api<Comment>(`/projects/${projectId}/leads/${leadId}/comments/${id}`, {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ body }),
      }),
    onSuccess: async () => {
      setEditingComment(null);
      await queryClient.invalidateQueries({ queryKey: ["comments", projectId, leadId] });
    },
  });
  const deleteComment = useMutation({
    mutationFn: (id: Comment["id"]) =>
      api<void>(`/projects/${projectId}/leads/${leadId}/comments/${id}`, {
        method: "DELETE",
        mutation: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["comments", projectId, leadId] }),
  });
  if (lead.isLoading) return <Loading />;
  return (
    <main className="page detail-page">
      <Link className="back" to={`/projects/${projectId}`}>
        ← All leads
      </Link>
      <Message error={lead.error} />
      {leadData && (
        <>
          <header className="detail-heading">
            <div>
              <span className="source">{leadData.source}</span>
              <h1>{leadData.title}</h1>
              <p>{[leadData.location, leadData.availability].filter(Boolean).join(" · ")}</p>
            </div>
            <div className="detail-price">
              <strong>{leadData.price_display || "Price unknown"}</strong>
              <a className="button primary" href={leadData.url} target="_blank" rel="noreferrer">
                Open listing ↗
              </a>
            </div>
          </header>
          <fieldset className="detail-actions">
            <legend className="sr-only">Lead actions</legend>
            <button
              className={`button ${leadData.interested || leadData.is_interested ? "selected" : ""}`}
              aria-pressed={Boolean(leadData.interested || leadData.is_interested)}
              onClick={() => interest.mutate(!(leadData.interested || leadData.is_interested))}
              type="button"
            >
              {leadData.interested || leadData.is_interested ? "♥ Interested" : "♡ Mark interested"}
            </button>
            <button
              className="button"
              onClick={() => setEditingLead((value) => !value)}
              type="button"
            >
              {editingLead ? "Close editor" : "Edit lead"}
            </button>
            {leadData.status === "trashed" ? (
              <button className="button" onClick={() => restore.mutate()} type="button">
                Restore
              </button>
            ) : (
              <button className="button danger-button" onClick={() => trash.mutate()} type="button">
                Move to trash
              </button>
            )}
          </fieldset>
          <Message error={interest.error ?? trash.error ?? restore.error} />
          {edit.error instanceof ApiError && edit.error.status === 409 && (
            <p className="message error" role="alert">
              This lead changed elsewhere. Your draft is still here; reload the listing in another
              tab and choose which version to keep.
            </p>
          )}
          {editingLead && (
            <form
              className="panel editor lead-editor"
              onSubmit={(event) => {
                event.preventDefault();
                edit.mutate();
              }}
            >
              <label>
                Title
                <input
                  value={String(leadDraft.title ?? "")}
                  onChange={(event) => setLeadDraft({ ...leadDraft, title: event.target.value })}
                  required
                />
              </label>
              <label>
                Listing URL
                <input
                  type="url"
                  value={String(leadDraft.url ?? "")}
                  onChange={(event) => setLeadDraft({ ...leadDraft, url: event.target.value })}
                  required
                />
              </label>
              <label>
                Summary
                <textarea
                  rows={6}
                  value={String(leadDraft.summary ?? "")}
                  onChange={(event) => setLeadDraft({ ...leadDraft, summary: event.target.value })}
                />
              </label>
              <div className="form-grid">
                <label>
                  Location
                  <input
                    value={String(leadDraft.location ?? "")}
                    onChange={(event) =>
                      setLeadDraft({ ...leadDraft, location: event.target.value })
                    }
                  />
                </label>
                <label>
                  Price
                  <input
                    value={String(leadDraft.price_display ?? "")}
                    onChange={(event) =>
                      setLeadDraft({ ...leadDraft, price_display: event.target.value })
                    }
                  />
                </label>
              </div>
              <Message
                error={
                  edit.error && edit.error instanceof ApiError && edit.error.status !== 409
                    ? edit.error
                    : null
                }
              />
              <button className="button primary" disabled={edit.isPending} type="submit">
                Save lead
              </button>
            </form>
          )}
          <div className="detail-grid">
            <article className="panel prose">
              <h2>What we know</h2>
              <p>{leadData.summary || "No summary yet."}</p>
              <dl className="lead-facts">
                <div>
                  <dt>Housing type</dt>
                  <dd>{leadData.housing_type || "Unknown"}</dd>
                </div>
                <div>
                  <dt>Date confidence</dt>
                  <dd>{leadData.date_confidence || "Unknown"}</dd>
                </div>
              </dl>
            </article>
            <aside className="panel">
              <h2>
                Conversation <span className="quiet small">{comments.data?.items.length ?? 0}</span>
              </h2>
              <div className="comments">
                {comments.data?.items.map((item) => (
                  <div key={String(item.id)}>
                    <span className="avatar">
                      {(item.author_display_name ?? String(item.author_id)).slice(0, 1)}
                    </span>
                    <div className="comment-body">
                      {editingComment === item.id ? (
                        <>
                          <textarea
                            aria-label="Edit comment"
                            rows={3}
                            value={commentDraft}
                            onChange={(event) => setCommentDraft(event.target.value)}
                          />
                          <div className="inline-actions">
                            <button
                              className="button"
                              onClick={() =>
                                updateComment.mutate({ id: item.id, body: commentDraft })
                              }
                              type="button"
                            >
                              Save
                            </button>
                            <button
                              className="plain-button"
                              onClick={() => setEditingComment(null)}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p>{item.body}</p>
                          <small>
                            {item.author_display_name ?? `Member ${item.author_id}`} ·{" "}
                            {new Date(item.created_at).toLocaleString()}
                          </small>
                          {String(item.author_id) === String(me.data?.user.id) && (
                            <div className="inline-actions">
                              <button
                                className="plain-button"
                                onClick={() => {
                                  setEditingComment(item.id);
                                  setCommentDraft(item.body);
                                }}
                                type="button"
                              >
                                Edit
                              </button>
                              <button
                                className="plain-button danger"
                                onClick={() => deleteComment.mutate(item.id)}
                                type="button"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
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
                <Message error={addComment.error ?? updateComment.error ?? deleteComment.error} />
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

function AgentSetup() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [link, setLink] = useState<{
    user_code: string;
    agent_label: string;
    environment_note: string;
    requested_cadence_minutes: number | null;
    expires_at: string;
  } | null>(null);
  const [tokenName, setTokenName] = useState("My search assistant");
  const [newToken, setNewToken] = useState("");
  const tokens = useQuery({
    queryKey: ["agent-tokens"],
    queryFn: () => api<{ items: AgentToken[] }>("/auth/tokens"),
  });
  const findLink = useMutation({
    mutationFn: () =>
      api<typeof link>(`/auth/agent-links/${encodeURIComponent(code.trim().toUpperCase())}`),
    onSuccess: (result) => setLink(result),
  });
  const decide = useMutation({
    mutationFn: (action: "approve" | "deny") =>
      api<{ status: string }>(
        `/auth/agent-links/${encodeURIComponent(code.trim().toUpperCase())}`,
        { method: "POST", mutation: true, body: JSON.stringify({ action }) },
      ),
    onSuccess: () => {
      setLink(null);
      setCode("");
    },
  });
  const createToken = useMutation({
    mutationFn: () =>
      api<{ id: string; token: string; expires_at: string }>("/auth/tokens", {
        method: "POST",
        mutation: true,
        body: JSON.stringify({
          name: tokenName,
          scopes: [
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
          ],
        }),
      }),
    onSuccess: (result) => {
      setNewToken(result.token);
      queryClient.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/auth/tokens/${id}`, { method: "DELETE", mutation: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent-tokens"] }),
  });
  return (
    <main className="page">
      <header className="page-heading">
        <p className="eyebrow">Your assistant</p>
        <h1>Connect an agent safely</h1>
        <p>
          Approve a code shown by an assistant, or create a revocable access key for a setup that
          cannot use pairing.
        </p>
      </header>
      <div className="settings-grid">
        <section className="panel">
          <p className="eyebrow">Device pairing</p>
          <h2>Approve a connection</h2>
          <p className="quiet">
            Ask the assistant to start pairing. It will show a six-character code here.
          </p>
          <form
            className="inline-form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              findLink.mutate();
            }}
          >
            <label>
              Approval code
              <input
                inputMode="text"
                autoCapitalize="characters"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="ABC123"
                required
              />
            </label>
            <button className="button primary" disabled={findLink.isPending} type="submit">
              Check code
            </button>
          </form>
          <Message error={findLink.error ?? decide.error} />
          {link && (
            <div className="pairing-card" role="status">
              <p className="eyebrow">Connection request</p>
              <h3>{link.agent_label}</h3>
              {link.environment_note && <p>Running on: {link.environment_note}</p>}
              <p>
                Confirm that the code shown by the assistant is <strong>{link.user_code}</strong>.
                Nothing is shared until you approve.
              </p>
              <div className="inline-actions">
                <button
                  className="button primary"
                  onClick={() => decide.mutate("approve")}
                  type="button"
                >
                  Approve connection
                </button>
                <button
                  className="button danger-button"
                  onClick={() => decide.mutate("deny")}
                  type="button"
                >
                  Deny
                </button>
              </div>
            </div>
          )}
        </section>
        <section className="panel">
          <p className="eyebrow">Manual access key</p>
          <h2>Fallback connection</h2>
          <p className="quiet">
            The raw key is shown once. Give it to the setup running on your own computer, never
            paste it into a chat.
          </p>
          <form
            className="inline-form-stack"
            onSubmit={(event) => {
              event.preventDefault();
              createToken.mutate();
            }}
          >
            <label>
              Key name
              <input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                maxLength={120}
                required
              />
            </label>
            <Message error={createToken.error} />
            <button className="button primary" disabled={createToken.isPending} type="submit">
              Create access key
            </button>
          </form>
          {newToken && (
            <div className="key-callout" role="status">
              <p className="eyebrow">Shown once</p>
              <strong>Your access key is ready.</strong>
              <p>Copy it now. Homing cannot show it again.</p>
              <div className="copy-row">
                <input
                  aria-label="New access key"
                  readOnly
                  value={newToken}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  className="button"
                  onClick={() => navigator.clipboard?.writeText(newToken)}
                  type="button"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
      <section className="panel token-list">
        <p className="eyebrow">Existing keys</p>
        <h2>Revoke access</h2>
        <Message error={tokens.error ?? revoke.error} />
        {tokens.data?.items.length ? (
          tokens.data.items.map((token) => (
            <div className="token-row" key={token.id}>
              <div>
                <strong>{token.name}</strong>
                <p className="quiet small">
                  {token.prefix} · expires {new Date(token.expires_at).toLocaleDateString()}
                  {token.revoked_at ? " · revoked" : ""}
                </p>
              </div>
              {!token.revoked_at && (
                <button className="button" onClick={() => revoke.mutate(token.id)} type="button">
                  Revoke
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="quiet">No manual keys yet.</p>
        )}
      </section>
    </main>
  );
}

function SourcePlanReviewPanel() {
  const repair = useQuery({
    queryKey: ["source-plan-repair"],
    queryFn: () => api<{ open_review_count: number; prompt: string }>("/me/source-plan-repair"),
    retry: false,
  });
  if (!repair.data || repair.data.open_review_count === 0) return null;
  return (
    <section className="panel source-review-panel" id="source-plan-review">
      <p className="eyebrow">Source plan review</p>
      <h2>Your assistant needs to review the existing setup</h2>
      <p>
        Homing flagged {repair.data.open_review_count} active search
        {repair.data.open_review_count === 1 ? "" : "es"}. The assistant will inspect the existing
        installation and repair it only when needed.
      </p>
      <p className="quiet">
        Copy this server-authored instruction and paste it into the assistant that manages your
        search.
      </p>
      <button
        className="button primary"
        onClick={() => navigator.clipboard?.writeText(repair.data.prompt)}
        type="button"
      >
        Copy the repair prompt
      </button>
      <details>
        <summary>See what it says</summary>
        <textarea
          aria-label="Server-authored repair prompt"
          readOnly
          rows={12}
          value={repair.data.prompt}
        />
      </details>
    </section>
  );
}

function Settings() {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api<Me["profile"]>("/me/profile"),
  });
  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [bio, setBio] = useState("");
  useEffect(() => {
    if (profile.data) {
      setDisplayName(profile.data.display_name);
      setTimezone(profile.data.timezone);
      setBio(profile.data.bio);
    }
  }, [profile.data]);
  const save = useMutation({
    mutationFn: () =>
      api<Me["profile"]>("/me/profile", {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ display_name: displayName, timezone, bio }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["profile"], data);
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const pause = useMutation({
    mutationFn: (pausedUntil: string | null) =>
      api<Me["profile"]>("/me/profile", {
        method: "PATCH",
        mutation: true,
        body: JSON.stringify({ agent_paused_until: pausedUntil }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["profile"], data);
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const paused = profile.data?.agent_paused_until
    ? new Date(profile.data.agent_paused_until) > new Date()
    : false;
  return (
    <main className="page">
      <header className="page-heading">
        <p className="eyebrow">Account</p>
        <h1>Settings</h1>
        <p>Keep your profile current and control whether scheduled agents may act.</p>
      </header>
      <SourcePlanReviewPanel />
      <div className="settings-grid">
        <form
          className="panel editor"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <p className="eyebrow">Profile</p>
          <h2>How others see you</h2>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
          <label>
            Timezone
            <input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="America/New_York"
              required
            />
          </label>
          <label>
            Bio
            <textarea
              rows={6}
              maxLength={5000}
              value={bio}
              onChange={(event) => setBio(event.target.value)}
            />
          </label>
          <Message error={save.error} />
          <button className="button primary" disabled={save.isPending} type="submit">
            Save profile
          </button>
        </form>
        <section className="panel">
          <p className="eyebrow">Agent schedule</p>
          <h2>{paused ? "Search is paused" : "Search is active"}</h2>
          <p>
            {paused
              ? `Scheduled agents will not act until ${profile.data?.agent_paused_until ? new Date(profile.data.agent_paused_until).toLocaleString() : "you resume"}.`
              : "Scheduled agents may run against your current searches."}
          </p>
          <Message error={pause.error} />
          <button
            className="button primary"
            disabled={pause.isPending}
            onClick={() =>
              pause.mutate(paused ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
            }
            type="button"
          >
            {paused ? "Resume agents" : "Pause for 24 hours"}
          </button>
        </section>
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
        <Route path="/projects/:projectId/*" element={<ProjectPage />} />
        <Route path="/agent-setup" element={<AgentSetup />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const invitationMatch = location.pathname.match(/^\/invitations\/([^/]+)\/accept\/?$/);
  const invitationToken = invitationMatch?.[1] ? decodeURIComponent(invitationMatch[1]) : null;
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const onExpired = () => {
      queryClient.clear();
      setExpired(true);
    };
    window.addEventListener("homing:session-expired", onExpired);
    return () => window.removeEventListener("homing:session-expired", onExpired);
  }, [queryClient]);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/me"),
    retry: false,
    enabled: !expired,
  });
  if (invitationToken) {
    if (me.isLoading) return <Loading />;
    return (
      <InvitationPage
        token={invitationToken}
        authenticated={Boolean(me.data)}
        onComplete={(projectId) => navigate(`/projects/${projectId}`)}
      />
    );
  }
  if (expired) return <LoginPage expired onSuccess={() => setExpired(false)} />;
  if (me.isLoading) return <Loading />;
  if (me.error instanceof ApiError && me.error.status === 401)
    return <LoginPage onSuccess={() => me.refetch()} />;
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
