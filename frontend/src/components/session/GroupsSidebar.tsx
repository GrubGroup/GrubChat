import { Icon } from '@/components/ui'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { GroupList } from '@/components/session/GroupList'
import { NewGroupModal } from '@/components/session/NewGroupModal'
import { useCreateGroup } from '@/hooks/useCreateGroup'

// Left column for the group-chat / agent-chat context: AppSidebar hosting the
// shared GroupList as its body. The list itself (rows, search, live sorting) lives
// in GroupList so the mobile Groups tab root renders the exact same one.
// Hidden below `md` via AppSidebar's `responsive` default — there the Groups tab
// root (BottomTabBar) shows that list full-screen instead.
export function GroupsSidebar() {
  const { modalOpen, openModal, closeModal, creating, handleCreate } = useCreateGroup()

  return (
    <AppSidebar
      eyebrow="Groups"
      // Wider panel so the group-chat list isn't cramped (~+15% vs default w-56).
      panelWidth="w-64"
      headerAction={
        <button
          onClick={openModal}
          aria-label="New group"
          // tap-target grows the hit area to 44px; the 28px pill is unchanged.
          className="tap-target flex h-7 w-7 items-center justify-center rounded-lg bg-surface-inverse text-on-inverse transition-opacity hover:opacity-90"
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      <GroupList />

      <NewGroupModal
        open={modalOpen}
        onClose={closeModal}
        onSubmit={handleCreate}
        pending={creating}
      />
    </AppSidebar>
  )
}
