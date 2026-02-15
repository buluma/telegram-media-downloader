// Central State Store

export const state = {
    currentPage: 'viewer',
    currentGroup: null,
    currentFilter: 'all',
    groups: [],
    downloads: [],
    files: [],
    allFiles: [],
    currentFileIndex: 0,
    config: {},
    page: 1,
    hasMore: true,
    loading: false,
    observer: null,
    imageObserver: null,
    viewMode: 'grid',
    searchQuery: ''
};
