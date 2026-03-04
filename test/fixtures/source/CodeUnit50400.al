codeunit 50400 "Temp Table Patterns"
{
    procedure ProcessWithTempTable()
    var
        TempBuffer: Record "Sales Line" temporary;
    begin
        TempBuffer.FindSet();
        repeat
            TempBuffer.CalcFields(Amount);
            TempBuffer.Modify();
        until TempBuffer.Next() = 0;
    end;

    procedure ProcessWithRealTable()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.FindSet();
        repeat
            SalesLine.CalcFields(Amount);
        until SalesLine.Next() = 0;
    end;
}
