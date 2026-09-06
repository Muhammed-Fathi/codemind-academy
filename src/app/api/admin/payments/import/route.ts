import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Admin Bulk Payment Import API
// Accepts an xlsx file, parses payment records, creates them in bulk.
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import * as XLSX from "xlsx";

// Expected columns: userEmail, amount, method (INSTAPAY|VODAFONE_CASH|ETISALAT_CASH),
// reference, status (PENDING|APPROVED|REJECTED), notes

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) return err(tApi("api.032"), 400);

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return err(tApi("api.033"), 400);

    const rows = XLSX.utils.sheet_to_json<any>(sheet);
    if (rows.length === 0) return err(tApi("api.034"), 400);

    const results: any[] = [];
    let created = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const userEmail = String(row.userEmail || row.email || row[tApi("api.035")] || "").trim().toLowerCase();
      const amount = parseFloat(String(row.amount || row[tApi("api.036")] || 0));
      const method = String(row.method || row[tApi("api.037")] || "INSTAPAY").trim().toUpperCase();
      const reference = row.reference || row[tApi("api.038")] ? String(row.reference || row[tApi("api.038")]) : null;
      const status = String(row.status || row[tApi("api.039")] || "PENDING").trim().toUpperCase();
      const notes = row.notes || row[tApi("api.040")] ? String(row.notes || row[tApi("api.040")]) : null;

      if (!userEmail || !amount) {
        results.push({
          row: i + 2,
          userEmail: userEmail || "—",
          status: "failed",
          error: tApi("api.041"),
        });
        failed++;
        continue;
      }

      // Find user by email
      const targetUser = await db.user.findUnique({
        where: { email: userEmail },
        select: { id: true, name: true },
      });
      if (!targetUser) {
        results.push({
          row: i + 2,
          userEmail,
          status: "failed",
          error: tApi("api.042"),
        });
        failed++;
        continue;
      }

      // Validate method
      const validMethod =
        method === "INSTAPAY" || method === "VODAFONE_CASH" || method === "ETISALAT_CASH"
          ? method
          : "INSTAPAY";

      // Validate status
      const validStatus =
        status === "APPROVED" || status === "REJECTED" || status === "EXPIRED"
          ? status
          : "PENDING";

      const payment = await db.payment.create({
        data: {
          userId: targetUser.id,
          amount,
          method: validMethod as any,
          status: validStatus as any,
          reference,
          notes,
        },
      });

      results.push({
        row: i + 2,
        userEmail,
        userName: targetUser.name,
        amount,
        method: validMethod,
        status: validStatus,
        paymentId: payment.id,
        status: "created",
      });
      created++;
    }

    return ok({
      created,
      failed,
      total: rows.length,
      results,
    });
  } catch (e: any) {
    console.error("[bulk payment import error]", e);
    return err(tApi("api.043"), 500);
  }
}

// GET — returns a template xlsx for download
export async function GET() {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const template = [
    {
      userEmail: "student@codemind.academy",
      amount: 200,
      method: "INSTAPAY",
      reference: "REF123456",
      status: "APPROVED",
      notes: tApi("api.044"),
    },
    {
      userEmail: "student2@codemind.academy",
      amount: 550,
      method: "VODAFONE_CASH",
      reference: "REF789012",
      status: "PENDING",
      notes: "",
    },
  ];

  const ws = XLSX.utils.json_to_sheet(template);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Payments");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="payments-template.xlsx"',
    },
  });
}
