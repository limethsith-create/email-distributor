"use client";

import { useState, useEffect, useCallback } from "react";
import { ConnectionCard } from "@/components/ConnectionCard";
import { Loader2, Info } from "lucide-react";

interface Connection {
  id: string;
  platform: string;
  accountName: string;
  accountId: string;
  connected: boolean;
}

const ALL_PLATFORMS = ["LINKEDIN", "FACEBOOK", "INSTAGRAM"];

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/connections");
      if (res.ok) {
        const data = await res.json();
        setConnections(data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleDisconnect = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/connections?id=${id}`, { method: "DELETE" });
        if (res.ok) {
          setConnections((prev) => prev.filter((c) => c.id !== id));
        }
      } catch {
        // silently fail
      }
    },
    []
  );

  const connectedCount = connections.filter((c) => c.connected).length;

  const getConnection = (platform: string) =>
    connections.find((c) => c.platform === platform && c.connected) || null;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Connections</h1>
        <p className="text-sm text-gray-400">
          Connect your social media accounts to start scheduling posts.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
        </div>
      ) : (
        <>
          {connectedCount === 0 && (
            <div className="card mb-6 border-accent/30 bg-accent/5">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-accent flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-medium text-white mb-1">
                    Get started by connecting an account
                  </h3>
                  <p className="text-xs text-gray-400">
                    Connect at least one social media platform below to begin
                    creating and scheduling posts. Your credentials are securely
                    stored and you can disconnect at any time.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-4">
            {ALL_PLATFORMS.map((platform) => (
              <ConnectionCard
                key={platform}
                platform={platform}
                connection={getConnection(platform)}
                onDisconnect={handleDisconnect}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
