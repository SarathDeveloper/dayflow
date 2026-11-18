import React from 'react';
import { Calendar, Home, Plus, Repeat, Wallet } from 'lucide-react';
import { ActiveTab } from '../types';

interface BottomNavProps {
  activeTab: ActiveTab;
  onChangeTab: (tab: ActiveTab) => void;
  onOpenQuickAdd: () => void;
}

// Everything else lives in the sidebar drawer (header menu button / edge swipe).
const TABS = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'today', label: 'Today', icon: Calendar },
  { id: 'habits', label: 'Habits', icon: Repeat },
  { id: 'finance', label: 'Money', icon: Wallet },
] as const;

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onChangeTab,
  onOpenQuickAdd,
}) => {
  const addTitle =
    activeTab === 'today' || activeTab === 'finance'
      ? 'Add Expense or Income'
      : activeTab === 'diary'
        ? 'New note'
        : 'Quick Add Task';

  const renderTab = (tab: (typeof TABS)[number]) => {
    const Icon = tab.icon;
    const isActive = activeTab === tab.id;
    return (
      <button
        key={tab.id}
        onClick={() => onChangeTab(tab.id as ActiveTab)}
        aria-current={isActive ? 'page' : undefined}
        className={`flex flex-col items-center justify-center min-h-[52px] w-full min-w-0 pt-1.5 pb-1 rounded-xl transition-colors active:scale-95 touch-manipulation ${
          isActive
            ? 'text-indigo-600 dark:text-indigo-400 font-semibold'
            : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 font-medium'
        }`}
      >
        <Icon className={`w-[22px] h-[22px] ${isActive ? 'stroke-[2.4px]' : 'stroke-[1.8px]'}`} />
        <span className="text-[11px] mt-1 tracking-tight leading-none">{tab.label}</span>
      </button>
    );
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-t-[1.75rem] border-t border-x border-slate-200 dark:border-slate-800 shadow-[0_-4px_20px_rgba(15,23,42,0.06)] dark:shadow-[0_-4px_20px_rgba(0,0,0,0.35)] px-2 pt-1 pb-[calc(0.35rem+env(safe-area-inset-bottom,0px))] transition-colors select-none lg:hidden">
      <div className="max-w-lg mx-auto grid grid-cols-5 items-end">
        {TABS.slice(0, 2).map(renderTab)}

        {/* Center add button. The vault has its own add flow, so the slot stays empty there. */}
        <div className="flex justify-center">
          {activeTab !== 'vault' && (
            <button
              onClick={onOpenQuickAdd}
              title={addTitle}
              aria-label={addTitle}
              className="-mt-6 mb-1 w-14 h-14 rounded-full bg-gradient-to-tr from-indigo-600 to-violet-500 text-white flex items-center justify-center ring-4 ring-white dark:ring-slate-900 shadow-lg shadow-indigo-600/35 active:scale-95 transition-transform touch-manipulation focus:outline-none focus-visible:ring-indigo-300"
            >
              <Plus className="w-7 h-7 stroke-[2.4px]" />
            </button>
          )}
        </div>

        {TABS.slice(2).map(renderTab)}
      </div>
    </nav>
  );
};
