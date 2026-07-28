import { useState } from 'react'
import { useNavStore } from '@/stores/navStore'
import { useGroupsStore } from '@/stores/groupsStore'

// The create-a-group flow, shared by every host of the groups list. Each host
// places its own "+" wherever its chrome puts one (the desktop sidebar's header
// slot, the mobile Groups tab root's header) and renders its own
// NewGroupModal with these props — the flow itself lives here once.
export function useCreateGroup() {
  const go = useNavStore((s) => s.go)
  const setGroup = useNavStore((s) => s.setGroup)
  const addGroup = useGroupsStore((s) => s.addGroup)
  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const handleCreate = async (name: string, memberIds: number[]) => {
    setCreating(true)
    try {
      const group = await addGroup(name, memberIds)
      setGroup(group.id)
      go('group-chat')
      setModalOpen(false)
    } finally {
      setCreating(false)
    }
  }

  return {
    modalOpen,
    openModal: () => setModalOpen(true),
    closeModal: () => setModalOpen(false),
    creating,
    handleCreate,
  }
}
