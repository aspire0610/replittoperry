import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAccountMeQueryKey,
  useGetAccountMe,
  usePutAccountWatchlist,
  type AccountProfile,
} from "@workspace/api-client-react";
import type { ReactNode } from "react";

export type WatchlistEntry = { symbol: string; name: string };

type AccountWatchlistValue = {
  entries: WatchlistEntry[];
  setEntries: (entries: WatchlistEntry[]) => void;
  profile: AccountProfile | undefined;
  isSignedIn: boolean;
  isLoading: boolean;
  isSaving: boolean;
  saveSucceeded: boolean;
  canEdit: boolean;
  canSave: boolean;
  isRefreshing: boolean;
  retryProfile: () => void;
  saveWatchlist: () => void;
  accountError: string | null;
  saveError: string | null;
  maxWatchlistItems: number;
};

const WATCHLIST_STORAGE_KEY = "tw-stock-dashboard-watchlist-v1";
const AccountWatchlistContext = createContext<AccountWatchlistValue | null>(null);

function readLocalWatchlist(): WatchlistEntry[] {
  try {
    if (typeof window === "undefined") return [];
    const stored = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
    if (!stored) return [];
    const value: unknown = JSON.parse(stored);
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is WatchlistEntry =>
            !!entry &&
            typeof entry.symbol === "string" &&
            typeof entry.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function readApiError(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("data" in error)) return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("error" in data)) return null;
  const message = (data as { error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message : null;
}

function readHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    status?: unknown;
    response?: { status?: unknown } | null;
  };
  if (typeof record.status === "number") return record.status;
  return typeof record.response?.status === "number"
    ? record.response.status
    : null;
}

export function AccountWatchlistProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn: authIsSignedIn, userId } = useAuth();
  const queryClient = useQueryClient();
  const [localEntries, setLocalEntries] = useState<WatchlistEntry[]>(readLocalWatchlist);
  const previousUserId = useRef<string | null>(null);
  const isSignedIn = isLoaded && authIsSignedIn === true;
  const profileQueryKey = useMemo(
    () => [...getGetAccountMeQueryKey(), userId ?? "signed-out"] as const,
    [userId],
  );
  const profileQuery = useGetAccountMe({
    query: {
      queryKey: profileQueryKey,
      enabled: isSignedIn && Boolean(userId),
      retry: (failureCount, error) =>
        readHttpStatus(error) === 401 && failureCount < 1,
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
    request: { credentials: "include" },
  });
  const watchlistMutation = usePutAccountWatchlist({
    request: { credentials: "include" },
  });

  const retryProfile = useCallback(() => {
    if (!isSignedIn) return;
    void profileQuery.refetch();
  }, [isSignedIn, profileQuery.refetch]);

  const saveWatchlist = useCallback(() => {
    const currentProfile = profileQuery.data;
    if (
      !isSignedIn ||
      !profileQuery.isSuccess ||
      !currentProfile ||
      watchlistMutation.isPending
    ) {
      return;
    }

    watchlistMutation.reset();
    watchlistMutation.mutate(
      { data: { watchlist: currentProfile.watchlist } },
      {
        onSuccess: (updatedProfile) => {
          queryClient.setQueryData(profileQueryKey, updatedProfile);
        },
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: profileQueryKey });
        },
      },
    );
  }, [
    isSignedIn,
    profileQuery.data,
    profileQuery.isSuccess,
    profileQueryKey,
    queryClient,
    watchlistMutation,
  ]);

  useEffect(() => {
    const previous = previousUserId.current;
    if (previous && previous !== userId) {
      queryClient.removeQueries({
        queryKey: [...getGetAccountMeQueryKey(), previous],
        exact: true,
      });
    }
    previousUserId.current = userId ?? null;
  }, [queryClient, userId]);

  const setEntries = useCallback(
    (entries: WatchlistEntry[]) => {
      if (!isLoaded) return;
      if (!isSignedIn) {
        setLocalEntries(entries);
        try {
          window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(entries));
        } catch {
          // Keep the list available in memory for this session.
        }
        return;
      }

      const currentProfile = profileQuery.data;
      if (!currentProfile || watchlistMutation.isPending) return;

      const normalized = entries.map((entry) => ({
        symbol: entry.symbol.trim().toUpperCase(),
        name: entry.name.trim().slice(0, 60) || entry.symbol.trim().toUpperCase(),
      }));
      const previousProfile = currentProfile;
      queryClient.setQueryData<AccountProfile>(profileQueryKey, {
        ...currentProfile,
        watchlist: normalized,
      });
      watchlistMutation.reset();
      watchlistMutation.mutate(
        { data: { watchlist: normalized } },
        {
          onSuccess: (updatedProfile) => {
            queryClient.setQueryData(profileQueryKey, updatedProfile);
          },
          onError: () => {
            queryClient.setQueryData(profileQueryKey, previousProfile);
            void queryClient.invalidateQueries({ queryKey: profileQueryKey });
          },
        },
      );
    },
    [
      isLoaded,
      isSignedIn,
      profileQuery.data,
      profileQueryKey,
      queryClient,
      watchlistMutation,
    ],
  );

  const value = useMemo<AccountWatchlistValue>(
    () => ({
      entries: !isLoaded
        ? []
        : isSignedIn
          ? profileQuery.data?.watchlist ?? []
          : localEntries,
      setEntries,
      profile: profileQuery.data,
      isSignedIn,
      isLoading: !isLoaded || (isSignedIn && profileQuery.isLoading),
      isSaving: watchlistMutation.isPending,
      saveSucceeded: watchlistMutation.isSuccess,
      canEdit:
        isLoaded &&
        (!isSignedIn ||
          (profileQuery.isSuccess && !watchlistMutation.isPending)),
      canSave:
        isLoaded &&
        isSignedIn &&
        profileQuery.isSuccess &&
        !watchlistMutation.isPending,
      isRefreshing: profileQuery.isFetching,
      retryProfile,
      saveWatchlist,
      accountError: profileQuery.isError
        ? readHttpStatus(profileQuery.error) === 401
          ? "登入狀態已載入，但帳號資料仍未通過驗證。請重新讀取；若仍失敗，請重新登入。"
          : readApiError(profileQuery.error) ?? "目前無法讀取帳號資料，請稍後重試。"
        : null,
      saveError: watchlistMutation.isError
        ? readApiError(watchlistMutation.error) ?? "自選清單同步失敗，請重試。"
        : null,
      maxWatchlistItems: profileQuery.data?.maxWatchlistItems ?? 100,
    }),
    [
      isLoaded,
      isSignedIn,
      profileQuery.isFetching,
      localEntries,
      profileQuery.data,
      profileQuery.error,
      profileQuery.isError,
      profileQuery.isLoading,
      profileQuery.isSuccess,
      retryProfile,
      saveWatchlist,
      setEntries,
      watchlistMutation.error,
      watchlistMutation.isError,
      watchlistMutation.isPending,
      watchlistMutation.isSuccess,
    ],
  );

  return (
    <AccountWatchlistContext.Provider value={value}>
      {children}
    </AccountWatchlistContext.Provider>
  );
}

export function useAccountWatchlist(): AccountWatchlistValue {
  const value = useContext(AccountWatchlistContext);
  if (!value) {
    throw new Error("useAccountWatchlist must be used inside AccountWatchlistProvider");
  }
  return value;
}