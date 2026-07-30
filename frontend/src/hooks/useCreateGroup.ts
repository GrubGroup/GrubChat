import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useGroupsStore } from '@/stores/groupsStore'
import { toSlugId } from '@/utils/slug'

// The create-a-group flow, shared by every host of the groups list. Each host
// places its own "+" wherever its chrome puts one (the desktop sidebar's header
// slot, the mobile Groups tab root's header) and renders its own
// NewGroupModal with these props — the flow itself lives here once.
export function useCreateGroup() {
  const navigate = useNavigate()
  const addGroup = useGroupsStore((s) => s.addGroup)
  const [modalOpen, setModalOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const handleCreate = async (name: string, memberIds: number[]) => {
    setCreating(true)
    try {
      const group = await addGroup(name, memberIds)
      navigate(`/groups/${toSlugId(group.name, group.id)}`)
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
