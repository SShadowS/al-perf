page 50804 "Temp Source Page"
{
    PageType = List;
    SourceTable = Vendor;
    SourceTableTemporary = true;

    layout
    {
        area(content)
        {
        }
    }

    procedure FillFromJournal(var GenJnlLine: Record "Gen. Journal Line")
    var
        Vend: Record Vendor;
    begin
        // Rec is the page's own source table and SourceTableTemporary = true,
        // so every Rec operation here is in-memory -- no SQL at all. Vend is a
        // real Record: its Get() per iteration IS an N+1.
        if GenJnlLine.FindSet() then
            repeat
                if not Get(GenJnlLine."Account No.") then begin
                    Vend.Get(GenJnlLine."Account No.");
                    Rec := Vend;
                    Insert();
                end;
            until GenJnlLine.Next() = 0;
    end;
}
