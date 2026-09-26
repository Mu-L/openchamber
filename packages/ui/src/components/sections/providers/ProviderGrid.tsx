import React from 'react';
import type { IntegrationInfo } from '@opencode/client';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import type { Model, Provider } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { getProviderCardStatus, readProviderApiKeySetting, type ProviderCardStatus } from './providerAuth';

type GridProvider = Provider & { models: Model[] };

interface ProviderGridProps {
  providers: readonly GridProvider[];
  /** Null while the integration list is loading; cards then show no status. */
  integrations: readonly IntegrationInfo[] | null;
  directory: string | null;
  onSelect: (providerId: string) => void;
  onConnect: () => void;
}

const CARD_CLASS = cn(
  'group flex min-h-[132px] flex-col rounded-xl border p-4 text-left transition-colors duration-150',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
);

/**
 * Providers configured in the selected project's own config. Everything else
 * comes from the user's config, credentials or the environment. Read through
 * the OpenChamber-only source endpoint, because the SDK does not expose which
 * config file defined a provider.
 */
const useProjectProviderIds = (providers: readonly GridProvider[], directory: string | null): ReadonlySet<string> => {
  const [projectIds, setProjectIds] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    let cancelled = false;
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    void Promise.all(providers.map(async (provider) => {
      try {
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(provider.id)}/source${query}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null);
        const sources = payload?.sources ?? payload?.data?.sources;
        return sources?.project?.exists === true ? provider.id : null;
      } catch {
        // A provider whose source cannot be read just loses its Project chip.
        return null;
      }
    })).then((ids) => {
      if (!cancelled) setProjectIds(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [directory, providers]);

  return projectIds;
};

const StatusPill: React.FC<{ status: ProviderCardStatus }> = ({ status }) => {
  const { t } = useI18n();
  const label = status.kind === 'accounts'
    ? t('settings.providers.card.status.accounts', { count: status.count })
    : status.kind === 'connected'
      ? t('settings.providers.card.status.connected')
      : status.kind === 'environment'
        ? t('settings.providers.card.status.environment')
        : t('settings.providers.card.status.signInNeeded');
  const tone = status.kind === 'signInNeeded'
    ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
    : status.kind === 'environment'
      ? 'bg-[var(--surface-muted)] text-muted-foreground'
      : 'bg-[var(--status-success)]/15 text-[var(--status-success)]';
  return (
    <span className={cn('max-w-40 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', tone)}>
      {label}
    </span>
  );
};

const ProviderCard: React.FC<{
  provider: GridProvider;
  status: ProviderCardStatus | null;
  fromProject: boolean;
  onSelect: (providerId: string) => void;
}> = ({ provider, status, fromProject, onSelect }) => {
  const { t } = useI18n();
  const modelCount = provider.models.length;

  return (
    <button
      type="button"
      onClick={() => onSelect(provider.id)}
      className={cn(
        CARD_CLASS,
        'border-[var(--interactive-border)] bg-[var(--surface-elevated)] hover:border-[var(--interactive-border-hover)] hover:bg-[var(--interactive-hover)]/50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
          <ProviderLogo providerId={provider.id} className="size-5" />
        </span>
        {status ? <StatusPill status={status} /> : null}
      </div>
      <div className="mt-3 min-w-0">
        <div className="truncate text-sm font-semibold text-foreground">{provider.name || provider.id}</div>
        <div className="mt-0.5 truncate font-mono typography-micro text-muted-foreground">{provider.id}</div>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-3 typography-micro text-muted-foreground">
        <span className="inline-flex items-center gap-1" aria-label={t('settings.providers.card.models', { count: modelCount })}>
          <Icon name="stack" className="size-3.5 opacity-70" aria-hidden />
          <span className="tabular-nums">{modelCount}</span>
        </span>
        {fromProject ? (
          <span className="rounded-full border border-[var(--interactive-border)] px-2 py-px text-[10px] font-medium">
            {t('settings.providers.card.source.project')}
          </span>
        ) : null}
        <Icon
          name="arrow-right-s"
          className="ml-auto size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-70 group-focus-visible:opacity-70"
          aria-hidden
        />
      </div>
    </button>
  );
};

/** Browse view of the Providers page: one card per provider OpenCode reports. */
export const ProviderGrid: React.FC<ProviderGridProps> = ({ providers, integrations, directory, onSelect, onConnect }) => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const projectIds = useProjectProviderIds(providers, directory);
  const filtered = rankByQuery([...providers], query, (provider) => [provider.name || provider.id, provider.id]);
  const hasQuery = query.trim().length > 0;

  return (
    <SettingsPageLayout
      title={t('settings.page.providers.title')}
      description={t('settings.providers.grid.description')}
      headerEnd={<SettingsProjectSelector className="w-full min-w-0 @xl:w-56" />}
    >
      {providers.length > 0 ? (
        <div className="relative mb-4 max-w-[24rem]">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.providers.grid.searchPlaceholder')}
            aria-label={t('settings.providers.grid.searchPlaceholder')}
            className="h-9 pl-8"
          />
        </div>
      ) : null}

      {providers.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.grid.empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.grid.noMatches', { query: query.trim() })}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
        {/* The one way in to connecting a provider, so it leads the grid. */}
        {hasQuery ? null : (
          <button
            type="button"
            onClick={onConnect}
            className={cn(
              CARD_CLASS,
              'items-center justify-center gap-2 border-dashed border-[var(--interactive-border)] text-muted-foreground hover:bg-[var(--interactive-hover)]/50 hover:text-foreground',
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
              <Icon name="add" className="size-5" />
            </span>
            <span className="typography-ui-label font-medium">{t('settings.providers.grid.connect')}</span>
            <span className="typography-micro">{t('settings.providers.grid.connectHint')}</span>
          </button>
        )}
        {filtered.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            status={getProviderCardStatus({
              integrations,
              providerId: provider.id,
              optionsApiKey: readProviderApiKeySetting(provider),
            })}
            fromProject={projectIds.has(provider.id)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </SettingsPageLayout>
  );
};
