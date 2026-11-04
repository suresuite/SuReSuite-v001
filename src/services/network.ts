// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { readAllPages } from '@/lib/pagedRead';
import { supabase } from '@/integrations/supabase/client';

export interface MultiTierNetworkData {
  id: string;
  project_id: string;
  plant_name: string;
  data_source: string;
  from_location: string;
  to_location: string;
  level: number;
  material_consumption_rate?: number;
  sourcing_ratio?: number;
  weighted?: number;
  path_root?: string;
  organization: string;
  uploaded_by?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Fetches multi-tier network data using RPC function with proper RLS context
 * Uses pagination to fetch ALL records, bypassing API limits
 */
export async function fetchMultiTierNetworkData(
  projectId: string,
  userId: string,
  userEmail: string
): Promise<MultiTierNetworkData[]> {
  console.log('🔐 Fetching multi-tier network data via RPC for project:', projectId);
  
  // Pages are read several at a time (`pagedRead.ts`). No page ceiling: this read has
  // never had one, and a silent cut here would draw a partial network.
  const { rows: allData, error } = await readAllPages<MultiTierNetworkData>(
    async (offset, limit) =>
      await supabase.rpc('get_supply_chain_data_multi_tier', {
        p_project_id: projectId,
        p_user_id: userId,
        p_user_email: userEmail,
        p_limit: limit,
        p_offset: offset,
      }),
    { maxPages: Number.POSITIVE_INFINITY },
  );
  if (error) {
    console.error('❌ RPC call failed:', error);
    throw new Error(`Failed to fetch multi-tier network data: ${(error as { message?: string }).message ?? String(error)}`);
  }

  console.log(`✅ Successfully fetched ALL ${allData.length} multi-tier network records`);
  
  // Debug: Count records by level to verify we have Level 5 data
  const levelCounts = allData.reduce((acc, record) => {
    const level = record.level || 0;
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {} as Record<number, number>);
  
  console.log('📊 Records by level:', levelCounts);
  
  // Specifically check for Level 5 inbound records
  const level5Inbound = allData.filter(r => r.level === 5 && r.data_source === 'inbound');
  console.log(`📊 Found ${level5Inbound.length} Level 5 inbound records`);
  
  return allData;
}