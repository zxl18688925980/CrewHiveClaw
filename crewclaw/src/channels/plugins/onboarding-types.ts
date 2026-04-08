import type { CrewClawConfig } from "../../config/config.js";
import type { DmPolicy } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ChannelId } from "./types.js";

export type SetupChannelsOptions = {
  allowDisable?: boolean;
  allowSignalInstall?: boolean;
  onSelection?: (selection: ChannelId[]) => void;
  accountIds?: Partial<Record<ChannelId, string>>;
  onAccountId?: (channel: ChannelId, accountId: string) => void;
  promptAccountIds?: boolean;
  whatsappAccountId?: string;
  promptWhatsAppAccountId?: boolean;
  onWhatsAppAccountId?: (accountId: string) => void;
  forceAllowFromChannels?: ChannelId[];
  skipStatusNote?: boolean;
  skipDmPolicyPrompt?: boolean;
  skipConfirm?: boolean;
  quickstartDefaults?: boolean;
  initialSelection?: ChannelId[];
  secretInputMode?: "plaintext" | "ref";
};

export type PromptAccountIdParams = {
  cfg: CrewClawConfig;
  prompter: WizardPrompter;
  label: string;
  currentId?: string;
  listAccountIds: (cfg: CrewClawConfig) => string[];
  defaultAccountId: string;
};

export type PromptAccountId = (params: PromptAccountIdParams) => Promise<string>;

export type ChannelOnboardingStatus = {
  channel: ChannelId;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};

export type ChannelOnboardingStatusContext = {
  cfg: CrewClawConfig;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelId, string>>;
};

export type ChannelOnboardingConfigureContext = {
  cfg: CrewClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelId, string>>;
  shouldPromptAccountIds: boolean;
  forceAllowFrom: boolean;
};

export type ChannelOnboardingResult = {
  cfg: CrewClawConfig;
  accountId?: string;
};

export type ChannelOnboardingConfiguredResult = ChannelOnboardingResult | "skip";

export type ChannelOnboardingInteractiveContext = ChannelOnboardingConfigureContext & {
  configured: boolean;
  label: string;
};

export type ChannelOnboardingDmPolicy = {
  label: string;
  channel: ChannelId;
  policyKey: string;
  allowFromKey: string;
  getCurrent: (cfg: CrewClawConfig) => DmPolicy;
  setPolicy: (cfg: CrewClawConfig, policy: DmPolicy) => CrewClawConfig;
  promptAllowFrom?: (params: {
    cfg: CrewClawConfig;
    prompter: WizardPrompter;
    accountId?: string;
  }) => Promise<CrewClawConfig>;
};

export type ChannelOnboardingAdapter = {
  channel: ChannelId;
  getStatus: (ctx: ChannelOnboardingStatusContext) => Promise<ChannelOnboardingStatus>;
  configure: (ctx: ChannelOnboardingConfigureContext) => Promise<ChannelOnboardingResult>;
  configureInteractive?: (
    ctx: ChannelOnboardingInteractiveContext,
  ) => Promise<ChannelOnboardingConfiguredResult>;
  configureWhenConfigured?: (
    ctx: ChannelOnboardingInteractiveContext,
  ) => Promise<ChannelOnboardingConfiguredResult>;
  dmPolicy?: ChannelOnboardingDmPolicy;
  onAccountRecorded?: (accountId: string, options?: SetupChannelsOptions) => void;
  disable?: (cfg: CrewClawConfig) => CrewClawConfig;
};
