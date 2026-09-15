import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

export const CLIENT_BASE_SERVICES = ['slots', 'sessions', 'workspaces', 'settingsScope', 'connection']
export const CLIENT_REMOTE_SERVICES = ['remote.session', 'remote.agentPresets']

/** Modern Remote namespaces require their own Cordis dependency scope.
 * Do not require them on legacy Hosts whose connection still owns the API.
 * The child scope also disposes/reinstalls UI registrations when a Remote is replaced.
 */
export function withClientServiceScope(ctx: ClientContext, install: (scope: ClientContext) => void): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  if (connection.api !== undefined) {
    install(ctx)
    return
  }
  ctx.inject(CLIENT_REMOTE_SERVICES, scope => install(scope as ClientContext))
}
