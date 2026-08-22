import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useParams, useSearchParams } from "react-router";
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

function TokenDate({ value, empty }: { value: string | null | undefined; empty: string }) {
  if (!value) return <>{empty}</>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <>{empty}</>;
  return <time dateTime={value}>{date.toLocaleString()}</time>;
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
      <header className="page-heading">
        <h1>Your shared searches</h1>
      </header>
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
        <h1>{project.data?.name}</h1>
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
        <Route
          path="members"
          element={<Members canManage={project.data?.role === "owner"} projectId={projectId} />}
        />
      </Routes>
    </main>
  );
}

function BriefEditor({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(project.prompt ?? project.current_prompt ?? "");
  useEffect(() => {
    setPrompt(project.prompt ?? project.current_prompt ?? "");
  }, [project]);
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

function Members({ projectId, canManage }: { projectId: string; canManage: boolean }) {
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
            {canManage && (
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
  const [comment, setComment] = useState("");
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api<Project>(`/projects/${projectId}`),
  });
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
        ← All {project.data?.name ? `${project.data.name} ` : ""}leads
      </Link>
      <Message error={lead.error} />
      {lead.data && (
        <>
          <header className="detail-heading">
            <h1>{lead.data.title}</h1>
            <strong className="detail-price">{lead.data.price_display || "Price unknown"}</strong>
            <a className="button primary" href={lead.data.url} target="_blank" rel="noreferrer">
              Open listing ↗
            </a>
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
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [timezone, setTimezone] = useState(profile.timezone);
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
            <input
              autoComplete="off"
              maxLength={64}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="America/New_York"
              required
              value={timezone}
            />
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
        <Route path="/projects/:projectId/*" element={<ProjectPage />} />
        <Route path="/agent-setup" element={<AgentSetupPage />} />
        <Route path="/settings" element={<SettingsPage me={me} />} />
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
