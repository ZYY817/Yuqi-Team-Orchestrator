/** New Hosts publish preset state as a projection; legacy Hosts use the root field. */
export function sessionPreset(row: { readonly agentPreset?: string | undefined; readonly projectionValues?: object | undefined } | undefined): string | undefined {
  if (row?.projectionValues && Object.prototype.hasOwnProperty.call(row.projectionValues, 'agentPreset')) {
    const value: unknown = Reflect.get(row.projectionValues, 'agentPreset')
    return typeof value === 'string' ? value : undefined
  }
  return row?.agentPreset
}
