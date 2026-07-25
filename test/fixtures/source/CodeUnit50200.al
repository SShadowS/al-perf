codeunit 50200 "Advanced Patterns"
{
    procedure ProcessNestedLoops()
    var
        SalesLine: Record "Sales Line";
        Item: Record Item;
    begin
        SalesLine.SetRange("Document Type", SalesLine."Document Type"::Order);
        SalesLine.FindSet();
        repeat
            Item.SetRange("No.", SalesLine."No.");
            if Item.FindSet() then
                repeat
                    Item.CalcFields("Inventory");
                until Item.Next() = 0;
        until SalesLine.Next() = 0;
    end;

    procedure UnfilteredQuery()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
        repeat
            Customer.CalcFields("Balance (LCY)");
        until Customer.Next() = 0;
    end;

    procedure FilteredQuery()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'SO-001');
        SalesLine.SetLoadFields("No.", "Quantity");
        SalesLine.FindSet();
    end;

    procedure LoopOverKeyFieldsInsideRecordLoop()
    var
        SalesLine: Record "Sales Line";
        KRef: KeyRef;
        FRef: FieldRef;
        RecRef: RecordRef;
        Filters: array[20] of Text;
        i: Integer;
    begin
        // The inner loop walks the KEY's fields through FieldRef -- bounded by
        // the key width, entirely in memory, no record op anywhere in it. It
        // multiplies CPU, not database round-trips, so calling it a nested-loop
        // performance problem is wrong.
        SalesLine.SetRange("Document No.", 'SO-001');
        if SalesLine.FindSet() then
            repeat
                RecRef.GetTable(SalesLine);
                KRef := RecRef.KeyIndex(1);
                for i := 1 to KRef.FieldCount do begin
                    FRef := KRef.FieldIndex(i);
                    Filters[i] := FRef.GetFilter;
                end;
            until SalesLine.Next() = 0;
    end;

    procedure FilteredBySetView()
    var
        SalesLine: Record "Sales Line";
    begin
        // SetView applies a filter group just as SetRange does — it is how a
        // caller-supplied filter string reaches the record.
        SalesLine.SetView(GetFilterText());
        SalesLine.FindSet();
    end;

    procedure RecordRefFindIsNotAnUnfilteredFindSet()
    var
        RecRef: RecordRef;
    begin
        // FIND_OPS matches method NAMES, and RecordRef has FindLast too. Its
        // filters live on FieldRef, so "add SetRange" is the wrong API.
        RecRef.GetTable(Rec);
        if RecRef.FindLast() then
            RecRef.Close();
    end;

    procedure SetCurrentKeyIsNotAFilter()
    var
        Item: Record Item;
    begin
        // SetCurrentKey chooses the sort order. It restricts nothing, so this
        // still reads every row in the table.
        Item.SetCurrentKey("No.");
        if Item.FindSet() then
            repeat
            until Item.Next() = 0;
    end;

    local procedure GetFilterText(): Text
    begin
        exit('');
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", 'OnBeforePostSalesDoc', '', true, true)]
    local procedure OnBeforePostSalesDoc(var SalesHeader: Record "Sales Header")
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        SalesLine.FindSet();
        repeat
            SalesLine.TestField("Quantity");
        until SalesLine.Next() = 0;
    end;

    procedure FindOnValueParameter(ParamLine: Record "Sales Line")
    begin
        // Filters travel WITH a record in AL, by value as well as by
        // reference. The caller may have filtered this one already, and
        // nothing in this member can see that.
        if ParamLine.FindSet() then;
    end;

    procedure FindOnVarParameter(var ParamLine2: Record "Sales Line")
    begin
        if ParamLine2.FindSet() then;
    end;

    [EventSubscriber(ObjectType::Table, Database::Customer, 'OnAfterModifyEvent', '', true, true)]
    local procedure OnAfterModifyCustomer(var Rec: Record Customer)
    var
        AuditLog: Record "Audit Log";
    begin
        AuditLog.SetRange("Source No.", Rec."No.");
        AuditLog.FindSet();
        repeat
            AuditLog.Modify();
        until AuditLog.Next() = 0;
    end;
}
