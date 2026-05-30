"use client";

import { useState, useCallback } from "react";
import { PostComposer } from "./PostComposer";
import { PostQueue } from "./PostQueue";

export function DashboardClient() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handlePostCreated = useCallback(() => {
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <PostComposer onPostCreated={handlePostCreated} />
      <PostQueue refreshTrigger={refreshTrigger} />
    </div>
  );
}
