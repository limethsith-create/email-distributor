"use client";

import {
  Linkedin,
  Facebook,
  Instagram,
  CheckCircle2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { clsx } from "clsx";
import { useState, useCallback } from "react";

interface Connection {
  id: string;
  platform: string;
  accountName: string;
  accountId: string;
  connected: boolean;
}

interface ConnectionCardProps {
  platform: string;
  connection: Connection | null;
  onDisconnect: (id: string) => Promise<void>;
}

const platformMeta: Record<
  string,
  { icon: React.ElementType; label: string; color: string; bgColor: string; connectUrl: string }
> = {
  LINKEDIN: {
    icon: Linkedin,
    label: "LinkedIn",
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    connectUrl: "/api/auth/linkedin",
  },
  FACEBOOK: {
    icon: Facebook,
    label: "Facebook",
    color: "text-blue-500",
    bgColor: "bg-blue-600/10",
    connectUrl: "/api/auth/facebook",
  },
  INSTAGRAM: {
    icon: Instagram,
    label: "Instagram",
    color: "text-pink-400",
    bgColor: "bg-pink-500/10",
    connectUrl: "/api/auth/instagram",
  },
};

export function ConnectionCard({ platform, connection, onDisconnect }: ConnectionCardProps) {
  const [disconnecting, setDisconnecting] = useState(false);
  const meta = platformMeta[platform];

  const handleDisconnect = useCallback(async () => {
    if (!connection) return;
    setDisconnecting(true);
    try {
      await onDisconnect(connection.id);
    } finally {
      setDisconnecting(false);
    }
  }, [connection, onDisconnect]);

  if (!meta) return null;

  const Icon = meta.icon;
  const isConnected = !!connection?.connected;

  return (
    <div
      className={clsx(
        "card transition-all duration-200 hover:border-gray-500",
        isConnected && "ring-1 ring-emerald-500/20"
      )}
    >
      <div className="flex items-start gap-4">
        {/* Platform Icon */}
        <div
          className={clsx(
            "flex h-12 w-12 items-center justify-center rounded-xl flex-shrink-0",
            meta.bgColor
          )}
        >
          <Icon className={clsx("h-6 w-6", meta.color)} />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-white">{meta.label}</h3>
            {isConnected ? (
              <span className="badge-connected">
                <CheckCircle2 className="h-3 w-3" />
                Connected
              </span>
            ) : (
              <span className="badge-disconnected">Not connected</span>
            )}
          </div>

          {isConnected && connection ? (
            <p className="text-sm text-gray-400 truncate">{connection.accountName}</p>
          ) : (
            <p className="text-xs text-gray-500">
              Connect your {meta.label} account to start scheduling posts.
            </p>
          )}
        </div>

        {/* Action */}
        <div className="flex-shrink-0">
          {isConnected ? (
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="btn-danger text-xs px-3 py-1.5"
            >
              {disconnecting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Disconnect"
              )}
            </button>
          ) : (
            <a href={meta.connectUrl} className="btn-primary text-xs px-3 py-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Connect
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
