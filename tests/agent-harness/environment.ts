import { delimiter, isAbsolute, join } from "node:path";

const sensitiveName =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTHORIZATION|AWS_|AZURE_|GOOGLE_|SSH_AUTH_SOCK|NPM_CONFIG_USERCONFIG)/i;

const certificateOverride =
  /^(SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/;

export type VirtualEnvironmentOptions = {
  root: string;
  home: string;
  temp: string;
  toolBin: string;
  codexHome: string;
  xdgConfig: string;
  xdgState: string;
  xdgCache: string;
  user?: string;
  locale?: string;
  timezone?: string;
  systemPath?: string[];
  declared?: Record<string, string>;
};

export type VirtualEnvironment = {
  values: Record<string, string>;
  allowedNames: string[];
  rejectedHostNames: string[];
};

function requireAbsolute(name: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
}

function defaultSystemPath(): string[] {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    return [join(root, "System32"), root];
  }
  return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
}

/** Build a child environment from declared values, never by cloning process.env. */
export function buildVirtualEnvironment(options: VirtualEnvironmentOptions): VirtualEnvironment {
  for (const [name, value] of Object.entries({
    root: options.root,
    home: options.home,
    temp: options.temp,
    toolBin: options.toolBin,
    codexHome: options.codexHome,
    xdgConfig: options.xdgConfig,
    xdgState: options.xdgState,
    xdgCache: options.xdgCache,
  })) {
    requireAbsolute(name, value);
  }

  const user = options.user ?? "homing-user";
  const locale = options.locale ?? "C.UTF-8";
  const timezone = options.timezone ?? "UTC";
  const values: Record<string, string> = {
    HOME: options.home,
    USER: user,
    LOGNAME: user,
    TMPDIR: options.temp,
    TMP: options.temp,
    TEMP: options.temp,
    XDG_CONFIG_HOME: options.xdgConfig,
    XDG_STATE_HOME: options.xdgState,
    XDG_CACHE_HOME: options.xdgCache,
    CODEX_HOME: options.codexHome,
    LANG: locale,
    LC_ALL: locale,
    TZ: timezone,
    PATH: [options.toolBin, ...(options.systemPath ?? defaultSystemPath())].join(delimiter),
  };

  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "LOCALAPPDATA", "APPDATA"] as const) {
      const value = process.env[name];
      if (value) values[name] = value;
    }
  }

  for (const [name, value] of Object.entries(options.declared ?? {})) {
    if (sensitiveName.test(name)) {
      throw new Error(
        `Sensitive environment variable must use a one-child credential channel: ${name}`,
      );
    }
    if (certificateOverride.test(name) && !isAbsolute(value)) {
      throw new Error(`Fixture certificate override must be an absolute path: ${name}`);
    }
    values[name] = value;
  }

  const rejectedHostNames = Object.keys(process.env)
    .filter(
      (name) => sensitiveName.test(name) || certificateOverride.test(name) || /proxy/i.test(name),
    )
    .sort();

  return {
    values,
    allowedNames: Object.keys(values).sort(),
    rejectedHostNames,
  };
}

export function sensitiveEnvironmentNames(values: Record<string, string | undefined>): string[] {
  return Object.keys(values)
    .filter((name) => sensitiveName.test(name))
    .sort();
}
