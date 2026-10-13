import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { LayoutGroup } from "framer-motion";

type CardOrderContextValue = {
  cardIds: string[];
  order: string[];
  moveBy: (cardId: string, delta: -1 | 1) => void;
};

const CardOrderContext = createContext<CardOrderContextValue | null>(null);

function mergeCardOrder(order: string[], cardIds: string[]) {
  const validOrder = order.filter((id) => cardIds.includes(id));
  return [...new Set(validOrder), ...cardIds.filter((id) => !validOrder.includes(id))];
}

function moveCardInOrder(current: string[], cardId: string, targetId: string) {
  const from = current.indexOf(cardId);
  const to = current.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return current;
  const next = [...current];
  next.splice(from, 1);
  next.splice(to, 0, cardId);
  return next;
}

export function CardOrderWorkspace({
  storageKey,
  cardIds,
  order,
  onOrderChange,
  className = "",
  children,
}: {
  storageKey: string;
  cardIds: string[];
  order: string[];
  onOrderChange: (order: string[]) => void;
  className?: string;
  children: ReactNode;
}) {
  const cardIdSignature = cardIds.join("|");
  const orderedCards = useMemo(
    () => mergeCardOrder(order, cardIds),
    [cardIdSignature, order],
  );
  const moveBy = useCallback(
    (cardId: string, delta: -1 | 1) => {
      const index = orderedCards.indexOf(cardId);
      const targetId = orderedCards[index + delta];
      if (!targetId) return;
      const next = moveCardInOrder(orderedCards, cardId, targetId);
      if (next !== orderedCards) onOrderChange(next);
    },
    [onOrderChange, orderedCards],
  );
  const contextValue = useMemo(
    () => ({ cardIds, order: orderedCards, moveBy }),
    [cardIdSignature, orderedCards, moveBy],
  );

  return (
    <CardOrderContext.Provider value={contextValue}>
      <LayoutGroup id={storageKey}>
        <div
          className={`card-order-workspace ${className}`.trim()}
          data-testid={`card-order-workspace-${storageKey}`}
        >
          {children}
        </div>
      </LayoutGroup>
    </CardOrderContext.Provider>
  );
}

export function useCardOrder(cardId: string) {
  const workspace = useContext(CardOrderContext);
  if (!workspace) {
    throw new Error("useCardOrder must be used inside CardOrderWorkspace.");
  }
  if (!workspace.cardIds.includes(cardId)) {
    throw new Error(`Card "${cardId}" is outside its registered order group.`);
  }

  const orderIndex = workspace.order.indexOf(cardId);
  return {
    orderIndex,
    canMoveUp: orderIndex > 0,
    canMoveDown: orderIndex >= 0 && orderIndex < workspace.order.length - 1,
    moveBy: (delta: -1 | 1) => workspace.moveBy(cardId, delta),
  };
}
