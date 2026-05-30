"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Trash2,
  Loader2,
  Calendar,
  Linkedin,
  Facebook,
  Instagram,
  InboxIcon,
  RefreshCw,
} from "lucide-react";
import { clsx } from "clsx";
import { format } from "date-fns";

interface Post {
  id: string;
  content: string;
  mediaUrl: string | null;
  mediaType: string;
  platforms: string[];
  status: "DRAFT" | "SCHEDULED" | "PUBLISHED" | "FAILED";
  scheduledAt: string | null;
  createdAt: string;
}

const platformIcons: Record<string, React.ElementType> = {
  LINKEDIN: Linkedin,
  FACEBOOK: Facebook,
  INSTAGRAM: Instagram,
};

const platformColors: Record<string, string> = {
  LINKEDIN: "text-blue-400",
  FACEBOOK: "text-blue-500",
  INSTAGRAM: "text-pink-400",
};

const statusClasses: Record<string, string> = {
  SCHEDULED: "badge-scheduled",
  PUBLISHED: "badge-published",
  FAILED: "badge-failed",
  DRAFT: "badge-draft",
};

export function PostQueue({ refreshTrigger }: { refreshTrigger?: number }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/posts");
      if (res.ok) {
        const data = await res.json();
        setPosts(data);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPosts();
  }, [fetchPosts, refreshTrigger]);

  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        const res = await fetch(`/api/posts?id=${id}`, { method: "DELETE" });
        if (res.ok) {
          setPosts((prev) => prev.filter((p) => p.id !== id));
        }
      } catch {
        // silently fail
      } finally {
        setDeletingId(null);
      }
    },
    []
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Post Queue</h2>
        <button
          onClick={fetchPosts}
          disabled={loading}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-hover transition-colors"
        >
          <RefreshCw className={clsx("h-4 w-4", loading && "animate-spin")} />
        </button>
      </div>

      {loading && posts.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
        </div>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="mb-4 rounded-full bg-surface-base p-4">
            <InboxIcon className="h-8 w-8 text-gray-600" />
          </div>
          <h3 className="text-sm font-medium text-gray-400 mb-1">No posts yet</h3>
          <p className="text-xs text-gray-600 max-w-[200px]">
            Create your first post using the composer to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
          {posts.map((post) => (
            <div
              key={post.id}
              className="group rounded-lg border border-surface-border bg-surface-base p-4 transition-all duration-200 hover:border-gray-600"
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {post.platforms.map((p) => {
                    const Icon = platformIcons[p];
                    return Icon ? (
                      <Icon
                        key={p}
                        className={clsx("h-4 w-4", platformColors[p] || "text-gray-400")}
                      />
                    ) : null;
                  })}
                  <span className={statusClasses[post.status] || "badge-draft"}>
                    {post.status.charAt(0) + post.status.slice(1).toLowerCase()}
                  </span>
                </div>
                <button
                  onClick={() => handleDelete(post.id)}
                  disabled={deletingId === post.id}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200"
                >
                  {deletingId === post.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>

              {/* Content */}
              <p className="text-sm text-gray-300 line-clamp-2 mb-2">{post.content}</p>

              {/* Media thumbnail */}
              {post.mediaUrl && (
                <div className="mb-2 rounded-md overflow-hidden border border-surface-border">
                  <img
                    src={post.mediaUrl}
                    alt="Post media"
                    className="w-full h-24 object-cover"
                  />
                </div>
              )}

              {/* Footer */}
              {post.scheduledAt && (
                <div className="flex items-center gap-1.5 text-xs text-gray-500">
                  <Calendar className="h-3 w-3" />
                  {format(new Date(post.scheduledAt), "MMM d, yyyy 'at' h:mm a")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
