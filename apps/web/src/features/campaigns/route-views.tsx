import { withAuth } from '@components/app/split-layout/split-router/app-route-shell';
import { lazy } from 'solid-js';

const CampaignsWorkspace = lazy(async () => ({
  default: (await import('./campaigns')).CampaignsWorkspace,
}));

export const CampaignsRouteView = withAuth(() => <CampaignsWorkspace />);
