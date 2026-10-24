import type { ModelArtifact, Policy } from '@revlyra/core';
import { type ConfigFile, type LoadConfigOptions, loadConfig, type RevlyraConfig } from './config';
import { loadModel, loadPolicy } from './engine/policy';
import { ReviewService, type SemanticProvider } from './engine/service';
import { type Entitlements, type LicenseStatus, resolveLicense } from './license';
import type { Store } from './store';
import { createStore } from './store';

export const VERSION = '0.1.0';

export interface CreateRevlyraOptions {
  cwd?: string;
  config?: Partial<ConfigFile>;
  requireLicense?: boolean;
  store?: Store;
  allowOnlineLicense?: boolean;
  fetcher?: typeof fetch;
}

export interface RevlyraRuntime {
  config: RevlyraConfig;
  store: Store;
  service: ReviewService;
  entitlements: Entitlements;
  license: LicenseStatus;
  policy: Policy;
  model: ModelArtifact;
  close: () => Promise<void>;
}

export async function createRevlyra(options: CreateRevlyraOptions = {}): Promise<RevlyraRuntime> {
  const config = loadConfig({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.config ? { overrides: options.config } : {}),
    requirePepper: true,
  } satisfies LoadConfigOptions);

  const store = options.store ?? (await createStore(config));
  try {
    const { status, entitlements } = await resolveLicense({
      configDir: config.configDir,
      licenseKey: config.license.key,
      ...(config.license.publicKey ? { publicKey: config.license.publicKey } : {}),
      ...(config.license.server ? { licenseServer: config.license.server } : {}),
      graceDays: config.license.graceDays,
      allowOnline: options.allowOnlineLicense ?? true,
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });
    const policy = loadPolicy(config);
    const model = loadModel(config);

    let semanticProvider: SemanticProvider | undefined;
    if (config.detection.transformerEnabled) {
      try {
        const moduleName = '@revlyra/transformer';
        const module = (await import(moduleName)) as {
          createTransformer?: (options: Record<string, unknown>) => SemanticProvider;
        };
        semanticProvider = module.createTransformer?.({
          ...(config.detection.modelDir ? { modelDir: config.detection.modelDir } : {}),
          offline: config.detection.modelOffline,
          allowDownload: config.detection.allowModelDownloads,
          ...(config.detection.embeddingModel
            ? { embeddingModel: config.detection.embeddingModel }
            : {}),
          ...(config.detection.classifierModel
            ? { classifierModel: config.detection.classifierModel }
            : {}),
        });
      } catch {
        // Optional tier; `revlyra doctor` reports whether it is installed.
      }
    }

    const service = new ReviewService({
      store,
      config,
      entitlements,
      policy,
      model,
      ...(semanticProvider ? { semanticProvider } : {}),
    });
    if (options.requireLicense !== false) {
      try {
        service.assertLicense();
      } catch (error) {
        if (!options.store) await store.close();
        throw error;
      }
    }
    return {
      config,
      store,
      service,
      entitlements,
      license: status,
      policy,
      model,
      close: async () => {
        await store.close();
      },
    };
  } catch (error) {
    if (!options.store) {
      await store.close().catch(() => undefined);
    }
    throw error;
  }
}

export {
  type ConfigFile,
  configPaths,
  ensureConfigDir,
  loadConfig,
  loadEnvFiles,
  type RevlyraConfig,
  redactConfig,
  writeConfigFile,
  writeEnvLocal,
} from './config';
export * from './engine/context';
export * from './engine/policy';
export * from './engine/service';
export * from './jobs';
export * from './keys';
export * from './license';
export * from './media';
export * from './privacy';
export * from './sources';
export * from './store';
