// CodeMind Academy — Admin Bulk Payment Import API
// Accepts an xlsx file, parses payment records, creates them in bulk.
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import * as XLSX from "xlsx";

// Expected columns: userEmail, amount, method (INSTAPAY|VODAFONE_CASH|ETISALAT_CASH),
// reference, status (PENDING|APPROVED|REJECTED), notes

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) return err("ملف xlsx مطلوب", 400);

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return err("مفيش sheet في الملف", 400);

    const rows = XLSX.utils.sheet_to_json<any>(sheet);
    if (rows.length === 0) return err("الـsheet فاضي", 400);

    const results: any[] = [];
    let created = 0;
    let failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const userEmail = String(row.userEmail || row.email || row["الإيميل"] || "").trim().toLowerCase();
      const amount = parseFloat(String(row.amount || row["المبلغ"] || 0));
      const method = String(row.method || row["الطريقة"] || "INSTAPAY").trim().toUpperCase();
      const reference = row.reference || row["المرجع"] ? String(row.reference || row["المرجع"]) : null;
      const status = String(row.status || row["الحالة"] || "PENDING").trim().toUpperCase();
      const notes = row.notes || row["ملاحظات"] ? String(row.notes || row["ملاحظات"]) : null;

      if (!userEmail || !amount) {
        results.push({
          row: i + 2,
          userEmail: userEmail || "—",
          status: "failed",
          error: "بيانات ناقصة (الإيميل أو المبلغ)",
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
          error: "المستخدم مش موجود",
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
    return err("حصلت مشكلة في قراءة الملف. تأكد إنه xlsx صحيح.", 500);
  }
}

// GET — returns a template xlsx for download
export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const template = [
    {
      userEmail: "student@codemind.academy",
      amount: 200,
      method: "INSTAPAY",
      reference: "REF123456",
      status: "APPROVED",
      notes: "دفعة شهرية",
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
