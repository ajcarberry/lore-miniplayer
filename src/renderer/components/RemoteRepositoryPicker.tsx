import type { ReactElement } from 'react';
import { useState } from 'react';
import { Combobox, InputBase, Loader, useCombobox } from '@mantine/core';
import type { RemoteRepository } from '../hooks/useRemoteRepositories';

interface RemoteRepositoryPickerProps {
  readonly remoteRepos: RemoteRepository[];
  readonly isLoading: boolean;
  readonly disabled: boolean;
  readonly onSelect: (repo: RemoteRepository) => void;
}

// Searchable combobox listing the repositories available on the server
export function RemoteRepositoryPicker({
  remoteRepos,
  isLoading,
  disabled,
  onSelect,
}: RemoteRepositoryPickerProps): ReactElement {
  const [search, setSearch] = useState('');
  const [selectedName, setSelectedName] = useState('');

  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });

  const filteredRepos = remoteRepos.filter(repo =>
    repo.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={url => {
        const repo = remoteRepos.find(r => r.url === url);
        if (repo) {
          setSelectedName(repo.name);
          setSearch(repo.name);
          combobox.closeDropdown();
          onSelect(repo);
        }
      }}
    >
      <Combobox.Target>
        <InputBase
          label='Repository'
          placeholder='Search repositories...'
          value={search}
          onChange={event => {
            setSearch(event.currentTarget.value);
            setSelectedName('');
            combobox.openDropdown();
          }}
          onClick={() => combobox.openDropdown()}
          onFocus={() => {
            if (selectedName && search === selectedName) {
              setSearch('');
            }
          }}
          onBlur={() => {
            if (selectedName && !search) {
              setSearch(selectedName);
            }
          }}
          rightSection={isLoading ? <Loader size='xs' /> : <Combobox.Chevron />}
          rightSectionPointerEvents={isLoading ? 'none' : 'all'}
          required
          disabled={disabled}
          size='sm'
        />
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Options>
          {filteredRepos.length > 0 ? (
            filteredRepos.map(repo => (
              <Combobox.Option value={repo.url} key={repo.url}>
                {repo.name}
              </Combobox.Option>
            ))
          ) : (
            <Combobox.Empty>No repositories found</Combobox.Empty>
          )}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
