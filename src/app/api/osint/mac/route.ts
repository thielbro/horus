import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { safeAbortTimeout } from '@/lib/http-utils';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mac = searchParams.get('mac');

  if (!mac) {
    return NextResponse.json({ error: 'Missing MAC parameter' }, { status: 400 });
  }
  if (isRateLimited(getClientIp(req), 20, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  // Clean the MAC address format to allow varied inputs
  const cleanMac = mac.trim().toUpperCase().replace(/[^A-F0-9:-]/g, '');

  try {
    const res = await fetch(`https://macvendors.co/api/${encodeURIComponent(cleanMac)}`, {
      signal: safeAbortTimeout(8000),
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) {
      throw new Error(`MacVendors API HTTP ${res.status}`);
    }

    const data = await res.json();
    if (data && data.result && data.result.company) {
      return NextResponse.json({
        mac: cleanMac,
        vendor: data.result.company,
        address: data.result.address,
        prefix: data.result.mac_prefix
      });
    } else {
      return NextResponse.json({ mac: cleanMac, vendor: 'Not Found' });
    }
  } catch (error: any) {
    return NextResponse.json({ error: 'MAC lookup failed', detail: error.message }, { status: 502 });
  }
}
