import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import * as settingsApi from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'

/** Public API bridge: 0.1.2 provider method first, 0.1.1 helper second. */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const provider = ctx.settings
  const install = provider && Reflect.get(provider, 'installSection')
  if (typeof install === 'function') {
    Reflect.apply(install, provider, [ctx, ns, schema, entry, hooks])
    return
  }
  const legacy = Reflect.get(settingsApi, 'installSettingsSection')
  if (typeof legacy === 'function') {
    Reflect.apply(legacy, undefined, [ctx, ns, schema, entry, hooks])
    return
  }
  throw new Error('Host settings requires public settings.installSection or installSettingsSection')
}
