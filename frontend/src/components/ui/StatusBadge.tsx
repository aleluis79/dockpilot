// SPDX-License-Identifier: AGPL-3.0-or-later
import React from 'react'

interface StatusBadgeProps {
  status: string
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const norm = (status || '').toLowerCase()

  if (norm === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        {status}
      </span>
    )
  }

  if (norm === 'paused' || norm === 'restarting') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        {status}
      </span>
    )
  }

  if (norm === 'dead') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
        {status}
      </span>
    )
  }

  // Default: exited, created, etc.
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-elevated text-fg-muted border border-strong/50">
      <span className="w-1.5 h-1.5 rounded-full bg-fg-subtle" />
      {status}
    </span>
  )
}
