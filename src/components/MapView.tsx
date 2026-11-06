// @ts-nocheck — schema mismatch: this file targets a supply-chain schema not yet migrated into this project. Remove once tables/RPCs are created.
import { clusterPoints, BASE_RADIUS } from '@/lib/network/mapClusters';
import { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Node } from '@xyflow/react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { MapPin, Zap, Route, Factory } from 'lucide-react';

// The map hands Mapbox raw HTML in two places (the plant marker and its popup),
// where a React component cannot go. This is lucide's `Factory` as a string —
// paths copied verbatim from lucide-react/icons/factory.js — so the marker, the
// popup and the <Factory /> in the legend are all the same glyph (C7: lucide
// only). Keep it in sync if the icon set is upgraded.
const FACTORY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M17 18h1"/><path d="M12 18h1"/><path d="M7 18h1"/></svg>`;

import { Button } from '@/components/ui/button';

interface NodeData extends Record<string, unknown> {
  label: string;
  type: 'location';
  group?: 'A' | 'B' | 'C' | 'D';
  incoming: number;
  outgoing: number;
  incomingFlow: number;
  outgoingFlow: number;
}

interface MapViewProps {
  nodes: Node<NodeData>[];
  selectedNode: Node<NodeData> | null;
  onNodeClick: (node: Node<NodeData>) => void;
  projectId: string | null;
  plantData: { plant_name: string; plant_latitude: number; plant_longitude: number } | null;
  countryRiskMap: Record<string, string>;
}

const GROUP_COLORS = {
  A: 'hsl(142 76% 36%)', // Supplier - Green (using semantic token)
  B: 'hsl(48 96% 53%)', // Material - Yellow  
  C: 'hsl(221 83% 53%)', // Product - Blue
  D: 'hsl(25 95% 53%)', // Customer - Orange
  PLANT: 'hsl(262 83% 58%)', // Plant - Purple
};

const RISK_COLORS: Record<string, string> = {
  'Very High': '#dc2626', // Red
  'High': '#ea580c',      // Orange
  'Medium': '#eab308',    // Yellow
  'Low': '#16a34a',       // Green
  'Very Low': '#059669',  // Emerald
  'Unknown': '#9ca3af',   // Gray
};

export default function MapView({ nodes, selectedNode, onNodeClick, projectId, plantData, countryRiskMap }: MapViewProps)  {

  console.log('MapView nodes:', nodes);

  const { user } = useAuth();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<Map<string, mapboxgl.Marker>>(new Map());
  const [mapboxToken, setMapboxToken] = useState<string>('');
  const [geocoding, setGeocoding] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [showEdges, setShowEdges] = useState(false);
  const [showCountries, setShowCountries] = useState(true);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [dbNodes, setDbNodes] = useState<Array<{id:string; node_id:string; node_type:string|null; node_group:string|null; latitude:number|null; longitude:number|null; location_text:string|null;}>>([]);
  const [plant, setPlant] = useState<{latitude:number|null; longitude:number|null; name:string|null} | null>(null);

  // Add country labels functionality - only when map is loaded
  const addCountryLabels = useCallback(() => {
    if (!map.current || !mapLoaded) return;
    
    try {
      // Check if source already exists
      if (map.current.getSource('countries')) {
        return;
      }

      // map.current.addSource('countries', {
      //   type: 'vector',
      //   url: 'mapbox://mapbox.country-boundaries-v1'
      // });

      // map.current.addLayer({
      //   id: 'country-labels',
      //   source: 'countries',
      //   'source-layer': 'country_labels',
      //   type: 'symbol',
      //   layout: {
      //     'text-field': ['get', 'name_en'],
      //     'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      //     'text-size': 12,
      //     'text-transform': 'uppercase',
      //     'text-letter-spacing': 0.1,
      //   },
      //   paint: {
      //     'text-color': '#6b7280',
      //     'text-opacity': 0.6,
      //   },
      //   minzoom: 3,
      //   maxzoom: 8,
      // });
    } catch (error) {
      console.error('Error adding country labels:', error);
    }
  }, [mapLoaded]);

  const toggleCountryLabels = useCallback(() => {
    if (!map.current || !mapLoaded) return;
    
    try {
      const zoom = map.current.getZoom();
      const visibility = zoom >= 3 && zoom <= 8 && showCountries ? 'visible' : 'none';
      
      if (map.current.getLayer('country-labels')) {
        map.current.setLayoutProperty('country-labels', 'visibility', visibility);
      }
    } catch (error) {
      console.error('Error toggling country labels:', error);
    }
  }, [showCountries, mapLoaded]);

  // Fetch Mapbox token
  useEffect(() => {
    console.log('MapView: Fetching Mapbox token...');
    const fetchToken = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('get-mapbox-token');
        console.log('MapView: Token response:', { data, error });
        if (error) throw error;
        if (data?.token) {
          console.log('MapView: Token received successfully');
          setMapboxToken(data.token);
        } else {
          console.error('MapView: No token in response');
          toast.error('Mapbox token not configured. Please add MAPBOX_PUBLIC_TOKEN to edge function secrets.');
        }
      } catch (error) {
        console.error('Failed to fetch Mapbox token:', error);
        toast.error('Failed to load map configuration');
      }
    };
    fetchToken();
  }, []);

  // Initialize map
  useEffect(() => {
    console.log('MapView: Initialize map effect', { hasContainer: !!mapContainer.current, hasToken: !!mapboxToken });
    if (!mapContainer.current || !mapboxToken) return;

    console.log('MapView: Creating map instance...');
    mapboxgl.accessToken = mapboxToken;
    
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [0, 20], // Default center
      zoom: 2,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    
    map.current.on('load', () => {
      console.log('MapView: Map loaded successfully');
      setMapLoaded(true);
    });

    map.current.on('zoom', () => {
      if (showCountries && mapLoaded) {
        toggleCountryLabels();
      }
    });

    return () => {
      console.log('MapView: Cleaning up map');
      setMapLoaded(false);
      map.current?.remove();
    };
  }, [mapboxToken]);

  // Handle country labels when showCountries or mapLoaded changes
  useEffect(() => {
    if (!map.current || !mapLoaded) return;
    
    if (showCountries) {
      if (!map.current.getSource('countries')) {
        addCountryLabels();
      } else {
        toggleCountryLabels();
      }
    } else {
      try {
        if (map.current.getLayer('country-labels')) {
          map.current.setLayoutProperty('country-labels', 'visibility', 'none');
        }
      } catch (error) {
        console.error('Error hiding country labels:', error);
      }
    }
  }, [showCountries, mapLoaded, addCountryLabels, toggleCountryLabels]);

  // Create marker element - Enhanced with plant styling
const createMarkerElement = useCallback((node: Node<NodeData>, isSelected: boolean, nodeCount?: number, isPlant?: boolean, riskColor?: string) => {
    const el = document.createElement('div');
    const color = isPlant ? GROUP_COLORS.PLANT : GROUP_COLORS[node.data.group || 'A'];
    const size = isPlant ? 28 : (nodeCount && nodeCount > 1 ? 24 : (isSelected ? 20 : 16));
    
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.backgroundColor = color;
    el.style.borderRadius = '50%';
    el.style.border = '2px solid #ffffff'; // Reduced slightly to make room for the risk ring
    el.style.cursor = 'pointer';
    
    // 2. Apply the risk color as a thick outer ring
    const defaultShadow = isPlant 
      ? '0 6px 12px rgba(0,0,0,0.3)' 
      : '0 4px 8px rgba(0,0,0,0.25)';
      
    el.style.boxShadow = riskColor 
      ? `0 0 0 4px ${riskColor}, ${defaultShadow}` 
      : defaultShadow;
      
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontWeight = 'bold';
    el.style.fontSize = isPlant ? '14px' : '10px';
    el.style.color = '#ffffff';
    el.style.textShadow = '1px 1px 2px rgba(0,0,0,0.7)';
    el.style.transition = 'all 0.2s ease';
    
    // Add content based on type
    if (isPlant) {
      el.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; width: 14px; height: 14px;">${FACTORY_SVG}</div>`;
    } else if (nodeCount && nodeCount > 1) {
      el.textContent = nodeCount.toString();
      el.style.fontSize = '12px';
    }
    
    if (isSelected) {
      el.style.boxShadow = isPlant 
        ? '0 0 0 4px hsl(var(--ring) / 0.6), 0 6px 12px rgba(0,0,0,0.3)' 
        : '0 0 0 4px hsl(var(--ring) / 0.6), 0 4px 8px rgba(0,0,0,0.25)';
      el.style.transform = 'scale(1.1)';
    }
    
    el.addEventListener('click', () => onNodeClick(node));
    
    return el;
  }, [onNodeClick]);

  // Add edges rendering functionality
  const renderEdges = useCallback(() => {
    if (!map.current || !showEdges || dbNodes.length === 0 || !plant) return;

    // Remove existing edges
    if (map.current.getSource('edges')) {
      map.current.removeLayer('edges');
      map.current.removeSource('edges');
    }

    // Create edge data - connect suppliers to plant and plant to customers
    const edges: any[] = [];
    
    dbNodes.forEach(node => {
      if (node.latitude && node.longitude && plant.latitude && plant.longitude) {
        edges.push({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [Number(node.longitude), Number(node.latitude)],
              [Number(plant.longitude), Number(plant.latitude)]
            ]
          },
          properties: {
            nodeType: node.node_type
          }
        });
      }
    });

    if (edges.length > 0) {
      map.current.addSource('edges', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: edges
        }
      });

      map.current.addLayer({
        id: 'edges',
        type: 'line',
        source: 'edges',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'nodeType'], 'supplier'],
            GROUP_COLORS.A,
            GROUP_COLORS.D
          ],
          'line-width': 2,
          'line-opacity': 0.6
        }
      });
    }
  }, [showEdges, dbNodes, plant]);

  // Toggle edges
  const toggleEdges = useCallback(() => {
    setShowEdges(prev => {
      const newState = !prev;
      if (!newState && map.current?.getSource('edges')) {
        map.current.removeLayer('edges');
        map.current.removeSource('edges');
      }
      return newState;
    });
  }, []);

  // Update markers when project, nodes, or selection changes
  useEffect(() => {

    console.log('MapView: fetchAndRender effect triggered');
    console.log('MapView: map.current:', !!map.current);
    console.log('MapView: projectId:', projectId);
    console.log('MapView: mapLoaded:', mapLoaded);

    if (!map.current || !projectId || !user || !mapLoaded) {
      console.log('MapView: Bailing out - missing:', {
        noMap: !map.current,
        noProject: !projectId,
        noUser: !user,
        notLoaded: !mapLoaded
      });
      return;
    }

    console.log('MapView: Starting fetchAndRender for project:', projectId);
    
    const fetchAndRender = async () => {
      console.log('MapView: Fetching data for project:', projectId);
      
      // Use RPC to fetch nodes (handles RLS properly)
      const { data: fetchedNodes, error: nodesError } = await supabase.rpc('get_node_list', {
        p_project_id: projectId,
        p_plant_name: null,
        p_user_id: user.id,
        p_user_email: user.email
      });

      console.log('MapView: Fetched nodes via RPC:', { count: fetchedNodes?.length || 0, error: nodesError });
      
      // Filter for suppliers and customers only
      const supplierCustomerNodes = (fetchedNodes || []).filter(n => 
        n.node_type === 'supplier' || n.node_type === 'customer'
      );
      
      console.log('MapView: Supplier/Customer nodes:', { count: supplierCustomerNodes.length });
      setDbNodes(supplierCustomerNodes);

      console.log('MapView: Supplier/Customer nodes:', { count: supplierCustomerNodes.length });

      // ADD THIS LINE BELOW
      console.log('Node types:', supplierCustomerNodes.map(n => ({ 
        id: n.node_id, 
        type: n.node_type,
        group: n.node_group 
      })));

      // Fetch plant coordinates directly (should work for projects table)
      // const { data: projData, error: projError } = await supabase.rpc('get_project_details', {
      //   p_project_id: projectId,
      //   p_user_id: user.id,
      //   p_user_email: user.email
      // });
      // const proj = projData?.[0] || null;

      // const { data: proj, error: projError } = await supabase
      //   .from('projects')
      //   .select('plant_name, plant_latitude, plant_longitude')
      //   .eq('id', projectId)
      //   .maybeSingle();

      const proj = plantData;
        
      console.log('MapView: Fetched project:', { proj });
      setPlant(proj ? { latitude: proj.plant_latitude, longitude: proj.plant_longitude, name: proj.plant_name } : null);

      // Clear existing markers ONLY when we have new data
      markers.current.forEach(marker => marker.remove());
      markers.current.clear();

      // Group nearby nodes by location. One marker (and one popup) per cluster, so a map of
      // a thousand suppliers stays pannable: the radius is ~1 km as it always was, and widens
      // only when that would leave more than MAX_MARKERS (`lib/network/mapClusters.ts`).
      const points = [];
      (supplierCustomerNodes || []).forEach(n => {
        const lon = Number(n.longitude);
        const lat = Number(n.latitude);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          const group = (n.node_type?.toLowerCase() === 'supplier' || n.node_group?.toLowerCase() === 'supplier') ? 'A' : 'D';
          points.push({ lon, lat, group, ref: n });
        }
      });
      const { clusters: builtClusters, radius: clusterRadiusUsed } = clusterPoints(points);
      const clusteredNodes = new Map(builtClusters.map((c, i) => [String(i), c]));
      if (clusterRadiusUsed > BASE_RADIUS) {
        toast.info(`${points.length.toLocaleString('en-US')} locations grouped into ${builtClusters.length} markers — click a marker to list the locations it holds`);
      }

       // Add clustered markers
       let supplierCount = 0;
       let customerCount = 0;
       
       clusteredNodes.forEach((cluster, clusterKey) => {
         const { lon, lat, group, count, nodes } = cluster;
         const isMultiple = count > 1;

         const representativeNode = nodes[0];

         const countryStr = representativeNode.location_text ? representativeNode.location_text.split(',').pop()?.trim().toUpperCase() : '';
         const riskClass = countryRiskMap[countryStr || ''] || 'Unknown';
         const riskColor = RISK_COLORS[riskClass] || RISK_COLORS['Unknown'];
         
         // Use first node as representative
         const shortLabel = isMultiple 
           ? `${group}×${count}` 
           : (group === 'A' ? `S${supplierCount + 1}` : `C${customerCount + 1}`);
           
         console.log(`MapView: Adding ${isMultiple ? 'clustered' : 'single'} marker ${shortLabel} at coordinates [${lon}, ${lat}] for ${count} nodes`);
         
         const rfNode = nodes.find(n => nodes.find(rn => rn.node_id === n.id)) || {
           id: representativeNode.node_id,
           position: { x: 0, y: 0 },
           data: {
             label: shortLabel,
             type: 'location' as const,
             group,
             incoming: 0,
             outgoing: 0,
             incomingFlow: 0,
             outgoingFlow: 0,
           },
         } as Node<NodeData>;
         
          const isSelected = selectedNode?.id === representativeNode.node_id;
          const markerElement = createMarkerElement(rfNode, isSelected, count, false, riskColor);
         
         // Create marker with proper anchoring - ensure exact positioning
         const markerOffset: [number, number] = group === 'D' ? [12, 12] : [0, 0];

         const marker = new mapboxgl.Marker({ 
           element: markerElement,
           anchor: 'center',
           offset: markerOffset,
           pitchAlignment: 'map',
           rotationAlignment: 'map'
         })
           .setLngLat([lon, lat])
           .addTo(map.current!);

         // Create popup with cluster info
         const nodesList = nodes.map(n => `${n.node_id} (${n.location_text})`).join('<br>');
         const popup = new mapboxgl.Popup({ 
           offset: 25,
           closeButton: false,
           closeOnClick: false
         }).setHTML(`
           <div class="p-3 min-w-[150px]">
             <div class="flex justify-between items-start mb-1">
               <h3 class="font-semibold text-sm">${shortLabel}</h3>
               <span class="text-[10px] font-bold px-1.5 py-0.5 rounded text-white" style="background-color: ${riskColor}">${riskClass} Risk</span>
             </div>
             <p class="text-xs text-gray-600 mb-1">${group === 'A' ? 'Supplier' : 'Customer'}${count > 1 ? 's' : ''}</p>
             ${count > 1 ? `<p class="text-xs text-gray-700 mb-2">${count} nodes at this location:</p>` : ''}
             <div class="text-xs text-gray-500 max-h-20 overflow-y-auto">${nodesList}</div>
             <p class="text-xs text-gray-400 mt-1">${lat.toFixed(2)}°, ${lon.toFixed(2)}°</p>
           </div>
         `);
         marker.setPopup(popup);
         markers.current.set(representativeNode.node_id, marker);
         
         if (!isMultiple) {
           if (group === 'A') supplierCount++;
           else customerCount++;
         }
       });

       // Add plant marker last
       if (proj?.plant_longitude != null && proj?.plant_latitude != null) {
         const plon = Number(proj.plant_longitude);
         const plat = Number(proj.plant_latitude);
         if (Number.isFinite(plon) && Number.isFinite(plat)) {
            const plantNode: Node<NodeData> = {
              id: 'PLANT',
              position: { x: 0, y: 0 },
              data: {
                label: 'Plant',
                type: 'location',
                group: 'C',
                incoming: 0,
                outgoing: 0,
                incomingFlow: 0,
                outgoingFlow: 0,
              },
            };
            
            const markerElement = createMarkerElement(plantNode, selectedNode?.id === 'PLANT', undefined, true);
           const marker = new mapboxgl.Marker({ 
             element: markerElement,
             anchor: 'center',
             offset: [0, 0],
             pitchAlignment: 'map',
             rotationAlignment: 'map'
           })
             .setLngLat([plon, plat])
             .addTo(map.current!);

           const popup = new mapboxgl.Popup({ 
             offset: 25,
             closeButton: false,
             closeOnClick: false
            }).setHTML(`
              <div class="p-3 min-w-[140px]">
                <div class="flex items-center gap-2 mb-2">
                  <span class="inline-flex h-4 w-4 items-center justify-center">${FACTORY_SVG}</span>
                  <h3 class="font-semibold text-sm">Manufacturing Plant</h3>
                </div>
                <p class="text-xs text-muted-foreground mb-1">${proj.plant_name || 'Plant'}</p>
                <p class="text-xs text-gray-400">${plat.toFixed(3)}°, ${plon.toFixed(3)}°</p>
              </div>
            `);
           marker.setPopup(popup);
           markers.current.set('PLANT', marker);
         }
       }

       if (markers.current.size > 0) {
        const bounds = new mapboxgl.LngLatBounds();
        
        markers.current.forEach((marker) => {
          bounds.extend(marker.getLngLat());
        });

        map.current!.fitBounds(bounds, {
          padding: 80,
          maxZoom: 8,
          duration: 1000
        });
      }

      console.log(`Map markers added: ${supplierCount} suppliers, ${customerCount} customers, ${proj?.plant_longitude != null && proj?.plant_latitude != null ? 1 : 0} plant`);

      // Just log marker positions, no automatic bounds fitting
      if (markers.current.size > 0) {
        console.log('MapView: Added', markers.current.size, 'markers to map');
        markers.current.forEach((marker, id) => {
          const lngLat = marker.getLngLat();
          console.log(`Marker ${id}:`, lngLat.lng, lngLat.lat);
        });
      } else {
        console.log('MapView: No markers added to map');
      }
    };

    fetchAndRender();
  }, [projectId, user, refreshCounter, mapLoaded]); // Removed nodes and selectedNode from dependencies

  // Render edges when data changes
  useEffect(() => {
    if (showEdges) {
      renderEdges();
    }
  }, [showEdges, renderEdges]);

  const handleGeocodeLocations = async () => {
    if (!user || !projectId) return;
    
    setGeocoding(true);
    try {
      toast.info('Starting geocoding process...');
      
      const { data, error } = await supabase.functions.invoke('geocode-locations', {
        body: { projectId, userId: user.id }
      });
      
      if (error) throw error;
      
      const message = data?.message ? ` - ${data.message}` : '';
      toast.success(`Geocoded ${data?.processed || 0} locations successfully${message}`);
      
      // Trigger map refresh
      setRefreshCounter(prev => prev + 1);
    } catch (error) {
      console.error('Geocoding failed:', error);
      toast.error('Failed to geocode locations');
    } finally {
      setGeocoding(false);
    }
  };

  if (!mapboxToken) {
    return (
      <div className="h-full flex items-center justify-center bg-muted/10">
        <div className="text-center space-y-4">
          <MapPin className="h-12 w-12 mx-auto text-muted-foreground" />
          <div>
            <p className="text-muted-foreground">Map configuration required</p>
            <p className="text-sm text-muted-foreground">Please configure Mapbox token in edge function secrets</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div ref={mapContainer} className="absolute inset-0 rounded-lg" />
      
      {/* Control buttons */}
      <div className="absolute top-4 left-4 z-10 flex flex-col gap-2">
        <Button
          onClick={handleGeocodeLocations}
          disabled={geocoding || !projectId}
          variant="secondary"
          size="sm"
          className="bg-card/95 backdrop-blur-sm shadow-sm border"
        >
          <Zap className={`h-4 w-4 mr-2 ${geocoding ? 'animate-spin' : ''}`} />
          {geocoding ? 'Geocoding...' : 'Enhance Locations'}
        </Button>
        
        <div className="flex gap-1">
          <Button
            onClick={toggleEdges}
            variant={showEdges ? "default" : "outline"}
            size="sm"
            className="bg-card/95 backdrop-blur-sm shadow-sm border"
          >
            <Route className="h-4 w-4 mr-1" />
            Edges
          </Button>
          
          <Button
            onClick={() => setShowCountries(!showCountries)}
            variant={showCountries ? "default" : "outline"}
            size="sm"
            className="bg-card/95 backdrop-blur-sm shadow-sm border text-foreground"
          >
            <Factory className="h-4 w-4 mr-1" />
            Countries
          </Button>
        </div>
      </div>

      {/* Compact Modern Legend */}
      <div className="absolute bottom-4 right-4 bg-card/95 backdrop-blur-sm rounded-lg border shadow-sm">
        <div className="p-3">
          <h4 className="font-medium text-sm mb-3 text-foreground">Legend</h4>
          
          {/* Main legend items in compact grid */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            {[
              { key: 'A', label: 'Suppliers', color: GROUP_COLORS.A },
              { key: 'D', label: 'Customers', color: GROUP_COLORS.D },
              { key: 'PLANT', label: 'Plant', color: GROUP_COLORS.PLANT, special: true },
            ].map(({ key, label, color, special }) => (
              <div key={key} className="flex items-center gap-2">
                <div 
                  className={`rounded-full border-2 border-background shadow-sm flex items-center justify-center text-xs font-medium ${special ? 'w-6 h-6' : 'w-4 h-4'}`}
                  style={{ 
                    backgroundColor: color,
                    color: '#ffffff'
                  }}
                >
                  {special && <Factory className="h-3.5 w-3.5" aria-hidden="true" />}
                </div>
                <span className="text-xs font-medium text-foreground">{label}</span>
              </div>
            ))}
          </div>
          
          {/* Clustering indicator */}
          <div className="pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <div 
                className="rounded-full border-2 border-background shadow-sm flex items-center justify-center text-xs font-bold w-5 h-5"
                style={{ 
                  backgroundColor: GROUP_COLORS.D,
                  color: '#ffffff'
                }}
              >
                3
              </div>
              <span className="text-xs text-muted-foreground">Multiple nodes</span>
            </div>
          </div>
        </div>
      </div>

      {!projectId && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <p className="text-muted-foreground">Please select a project</p>
        </div>
      )}
    </div>
  );
}