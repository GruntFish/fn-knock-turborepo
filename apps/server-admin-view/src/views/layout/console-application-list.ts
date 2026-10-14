import type { AppConfig, DeploymentTarget, HostMapping } from "@/types";
import {
  resolveGatewayPortalTargetHref,
  usesGatewayPortalLanNavigation,
} from "@/lib/gateway-portal-navigation";
import {
  isAnySubdomainRoutingMode,
  normalizePublicAccessEntryPort,
  resolveExplicitPublicAccessEntryPort,
  resolvePublicAccessEntryProtocol,
  shouldOmitPublicAccessEntryPort,
} from "@/lib/reverse-proxy-submode";

export interface ConsoleApplicationItem {
  href: string;
  iconSrc: string;
  key: string;
  kind: "host" | "path";
  label: string;
  showIcon: boolean;
}

export interface ConsoleApplicationLocation {
  hostname: string;
  protocol: string;
}

type GatewayProtocol = "http:" | "https:";

export const isConsoleApplicationListAvailable = (
  deploymentTarget: DeploymentTarget | null | undefined,
): boolean => deploymentTarget === "fpk" || deploymentTarget === "fpk-lite";

export const shouldShowConsoleApplicationList = ({
  deploymentTarget,
  enabled,
}: {
  deploymentTarget: DeploymentTarget | null | undefined;
  enabled: unknown;
}): boolean =>
  isConsoleApplicationListAvailable(deploymentTarget) && enabled === true;

const normalizeGatewayPort = (value: unknown): string | null => {
  const port = normalizePublicAccessEntryPort(value);
  return port === null ? null : String(port);
};

const isDefaultGatewayPort = (
  protocol: GatewayProtocol,
  port: string,
): boolean =>
  (protocol === "https:" && port === "443") ||
  (protocol === "http:" && port === "80");

export const resolveConsoleApplicationGateway = (
  config: AppConfig,
  accessEntryPort: string,
): { port: string; protocol: GatewayProtocol } | null => {
  const protocol = resolvePublicAccessEntryProtocol(config);
  if (shouldOmitPublicAccessEntryPort(config)) {
    return { port: "", protocol };
  }

  const port =
    normalizeGatewayPort(
      isAnySubdomainRoutingMode(config)
        ? resolveExplicitPublicAccessEntryPort(
            config,
            protocol === "https:" ? "https" : "http",
          )
        : null,
    ) ?? normalizeGatewayPort(accessEntryPort);
  if (!port) return null;
  return {
    port: isDefaultGatewayPort(protocol, port) ? "" : port,
    protocol,
  };
};

const createGatewayUrl = (
  hostname: string,
  config: AppConfig,
  accessEntryPort: string,
): URL | null => {
  try {
    const normalizedHostname = hostname.trim();
    if (!normalizedHostname) return null;
    const gateway = resolveConsoleApplicationGateway(config, accessEntryPort);
    if (!gateway) return null;
    const url = new URL(`${gateway.protocol}//${normalizedHostname}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    url.port = gateway.port;
    return url;
  } catch {
    return null;
  }
};

export const buildConsoleHostApplicationHref = (
  host: string,
  _location: ConsoleApplicationLocation,
  config: AppConfig,
  accessEntryPort: string,
): string => createGatewayUrl(host.trim(), config, accessEntryPort)?.href ?? "";

export const buildConsolePathApplicationHref = (
  path: string,
  location: ConsoleApplicationLocation,
  config: AppConfig,
  accessEntryPort: string,
): string => {
  const url = createGatewayUrl(location.hostname, config, accessEntryPort);
  if (!url) return "";

  const trimmedPath = path.trim();
  const withLeadingSlash = trimmedPath.startsWith("/")
    ? trimmedPath
    : `/${trimmedPath}`;
  url.pathname = withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
  return url.href;
};

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const getEligibleHostMappings = (config: AppConfig): HostMapping[] => {
  if (!isAnySubdomainRoutingMode(config)) return [];
  return config.host_mappings.filter(
    (mapping) =>
      mapping.service_role !== "auth" &&
      mapping.disabled !== true &&
      normalizeText(mapping.host).length > 0,
  );
};

const orderHostMappings = (
  mappings: HostMapping[],
  config: AppConfig,
): HostMapping[] => {
  if (
    config.host_mapping_grouped_view !== true ||
    config.host_mapping_groups.length === 0
  ) {
    return mappings;
  }

  const validGroupIds = new Set(
    config.host_mapping_groups.map((group) => group.id),
  );
  const ordered = config.host_mapping_groups.flatMap((group) =>
    mappings.filter((mapping) => mapping.group_id === group.id),
  );
  ordered.push(
    ...mappings.filter(
      (mapping) =>
        mapping.group_id == null || !validGroupIds.has(mapping.group_id),
    ),
  );
  return ordered;
};

const resolveHostLabel = (mapping: HostMapping, config: AppConfig): string => {
  if (config.gateway_portal?.display_style === "domain") {
    return normalizeText(mapping.host);
  }
  return (
    normalizeText(mapping.title_override) ||
    normalizeText(mapping.title) ||
    normalizeText(mapping.host)
  );
};

const resolveHostIcon = (mapping: HostMapping, config: AppConfig): string => {
  if (config.gateway_portal?.show_app_icon === false) return "";
  const icon =
    normalizeText(mapping.favicon_override) || normalizeText(mapping.favicon);
  return /^data:image\//i.test(icon) ? icon : "";
};

export const buildConsoleApplicationItems = ({
  accessEntryPort,
  clientIsLan,
  config,
  location,
}: {
  accessEntryPort: string;
  clientIsLan?: boolean | null;
  config: AppConfig;
  location: ConsoleApplicationLocation;
}): ConsoleApplicationItem[] => {
  const useLan = usesGatewayPortalLanNavigation(
    config.gateway_portal,
    clientIsLan,
  );
  const hostMappings = orderHostMappings(
    getEligibleHostMappings(config),
    config,
  );
  if (hostMappings.length > 0) {
    const hostItems = hostMappings.flatMap((mapping) => {
      const directHref =
        useLan && (!mapping.target_type || mapping.target_type === "proxy")
          ? resolveGatewayPortalTargetHref(mapping.target)
          : "";
      const href =
        directHref ||
        buildConsoleHostApplicationHref(
          normalizeText(mapping.host),
          location,
          config,
          accessEntryPort,
        );
      if (!href) return [];
      return [
        {
          href,
          iconSrc: resolveHostIcon(mapping, config),
          key: `host:${mapping.host}`,
          kind: "host" as const,
          label: resolveHostLabel(mapping, config),
          showIcon: config.gateway_portal?.show_app_icon !== false,
        },
      ];
    });
    if (hostItems.length > 0) return hostItems;
  }

  return config.proxy_mappings.flatMap((mapping) => {
    const path = normalizeText(mapping.path);
    if (!path) return [];
    const href =
      (useLan ? resolveGatewayPortalTargetHref(mapping.target) : "") ||
      buildConsolePathApplicationHref(path, location, config, accessEntryPort);
    if (!href) return [];
    return [
      {
        href,
        iconSrc: "",
        key: `path:${path}`,
        kind: "path" as const,
        label: path,
        showIcon: true,
      },
    ];
  });
};
