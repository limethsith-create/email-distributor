"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Linkedin,
  Facebook,
  Instagram,
  CalendarX2,
} from "lucide-react";
import { clsx } from "clsx";
import {
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addWeeks,
  subWeeks,
  isSameDay,
  isToday,
} from "date-fns";

interface Post {
  id: string;
  content: string;
  mediaUrl: string | null;
  mediaType: string;
  platforms: string[];
  status: string;
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

export default function SchedulePage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentWeek, setCurrentWeek] = useState(new Date());

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/posts?status=SCHEDULED");
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
  }, [fetchPosts]);

  const weekStart = startOfWeek(currentWeek, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentWeek, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

  const getPostsForDay = (day: Date) =>
    posts.filter((p) => p.scheduledAt && isSameDay(new Date(p.scheduledAt), day));

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white mb-1">Schedule</h1>
        <p className="text-sm text-gray-400">
          View and manage your scheduled posts in a calendar view.
        </p>
      </div>

      {/* Week Navigation */}
      <div className="card mb-6">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setCurrentWeek(subWeeks(currentWeek, 1))}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-hover transition-colors"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="text-center">
            <h2 className="text-sm font-semibold text-white">
              {format(weekStart, "MMM d")} - {format(weekEnd, "MMM d, yyyy")}
            </h2>
            <button
              onClick={() => setCurrentWeek(new Date())}
              className="text-xs text-accent hover:text-accent-light transition-colors"
            >
              Go to this week
            </button>
          </div>
          <button
            onClick={() => setCurrentWeek(addWeeks(currentWeek, 1))}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-surface-hover transition-colors"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-gray-500" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
          {days.map((day) => {
            const dayPosts = getPostsForDay(day);
            const today = isToday(day);

            return (
              <div
                key={day.toISOString()}
                className={clsx(
                  "rounded-xl border p-3 min-h-[160px] transition-all duration-200",
                  today
                    ? "border-accent/40 bg-accent/5"
                    : "border-surface-border bg-surface-card hover:border-gray-500"
                )}
              >
                {/* Day header */}
                <div className="mb-2">
                  <p className="text-xs text-gray-500 uppercase">
                    {format(day, "EEE")}
                  </p>
                  <p
                    className={clsx(
                      "text-lg font-bold",
                      today ? "text-accent" : "text-white"
                    )}
                  >
                    {format(day, "d")}
                  </p>
                </div>

                {/* Posts */}
                {dayPosts.length > 0 ? (
                  <div className="space-y-2">
                    {dayPosts.map((post) => (
                      <div
                        key={post.id}
                        className="rounded-lg bg-surface-base border border-surface-border p-2 transition-colors hover:border-gray-500"
                      >
                        <p className="text-xs text-gray-300 line-clamp-2 mb-1.5">
                          {post.content}
                        </p>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            {post.platforms.map((p) => {
                              const Icon = platformIcons[p];
                              return Icon ? (
                                <Icon
                                  key={p}
                                  className={clsx(
                                    "h-3 w-3",
                                    platformColors[p] || "text-gray-400"
                                  )}
                                />
                              ) : null;
                            })}
                          </div>
                          {post.scheduledAt && (
                            <span className="text-[10px] text-gray-500">
                              {format(new Date(post.scheduledAt), "h:mm a")}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-16 opacity-30">
                    <CalendarX2 className="h-4 w-4 text-gray-600" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Upcoming list */}
      {!loading && posts.length > 0 && (
        <div className="card mt-6">
          <h3 className="text-sm font-semibold text-white mb-4">All Scheduled Posts</h3>
          <div className="space-y-3">
            {posts
              .filter((p) => p.scheduledAt)
              .sort(
                (a, b) =>
                  new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()
              )
              .map((post) => (
                <div
                  key={post.id}
                  className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-base p-3"
                >
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {post.platforms.map((p) => {
                      const Icon = platformIcons[p];
                      return Icon ? (
                        <Icon
                          key={p}
                          className={clsx(
                            "h-4 w-4",
                            platformColors[p] || "text-gray-400"
                          )}
                        />
                      ) : null;
                    })}
                  </div>
                  <p className="text-sm text-gray-300 truncate flex-1">{post.content}</p>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 flex-shrink-0">
                    <Calendar className="h-3 w-3" />
                    {post.scheduledAt &&
                      format(new Date(post.scheduledAt), "MMM d 'at' h:mm a")}
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
